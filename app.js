/* =========================================================
   Sun Finder — prototype logic
   Real calculations via SunCalc (sunrise/sunset/azimuth).
   Real browser APIs for geolocation + device orientation.
   No values are invented: anything we can't measure is shown
   as "--" or with an explicit message, not a guessed number.
   ========================================================= */

const state = {
  lat: null,
  lon: null,
  gpsAccuracyMeters: null,
  city: null,
  heading: null,            // compass heading in degrees, null until sensor reports
  headingSource: null,      // 'absolute' | 'webkit' | null
  timeFormat: '12',         // '12' | '24'
  theme: 'dark',
  arEnabled: true,
  calibrated: false,
  forecastDays: [],
  previewResult: null,      // { azimuth, altitudeDeg, dateTime } or null until computed
  pitch: null,               // degrees above horizon the camera is pointed; null until beta reported
};

// ---------- helpers ----------
function fmtTime(date){
  if (!date || isNaN(date.getTime())) return '--:--';
  let h = date.getHours();
  let m = date.getMinutes().toString().padStart(2,'0');
  if (state.timeFormat === '24') {
    return `${h.toString().padStart(2,'0')}:${m}`;
  }
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

function fmtAz(deg){
  if (deg === null || deg === undefined || isNaN(deg)) return '--°';
  return `${Math.round(deg)}°`;
}

// SunCalc gives azimuth in radians, measured from south, clockwise.
// Convert to standard compass bearing (0=N, 90=E, 180=S, 270=W).
function azToCompassBearing(azimuthRadians){
  const deg = azimuthRadians * 180 / Math.PI;
  return (deg + 180 + 360) % 360;
}

function shortDate(d){
  return d.toLocaleDateString(undefined, { weekday:'short' });
}
function dayNum(d){
  return d.getDate();
}
function monthShort(d){
  return d.toLocaleDateString(undefined, { month:'short' });
}

// ---------- screen navigation ----------
document.querySelectorAll('.navbtn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.navbtn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('screen-'+btn.dataset.screen).classList.add('active');
  });
});

// ---------- theme ----------
function setTheme(t){
  state.theme = t;
  document.body.setAttribute('data-theme', t);
  document.getElementById('themeLightBtn').classList.toggle('active', t==='light');
  document.getElementById('themeDarkBtn').classList.toggle('active', t==='dark');
}
document.getElementById('themeLightBtn').addEventListener('click', ()=>setTheme('light'));
document.getElementById('themeDarkBtn').addEventListener('click', ()=>setTheme('dark'));

// ---------- time format ----------
function setTimeFormat(f){
  state.timeFormat = f;
  document.getElementById('time12Btn').classList.toggle('active', f==='12');
  document.getElementById('time24Btn').classList.toggle('active', f==='24');
  renderToday();
  renderForecast();
  renderAR();
}
document.getElementById('time12Btn').addEventListener('click', ()=>setTimeFormat('12'));
document.getElementById('time24Btn').addEventListener('click', ()=>setTimeFormat('24'));

// ---------- AR toggle ----------
document.getElementById('arToggle').addEventListener('click', (e)=>{
  state.arEnabled = !state.arEnabled;
  e.currentTarget.classList.toggle('on', state.arEnabled);
});

// ---------- geolocation ----------
function classifyAccuracy(meters){
  if (meters === null || meters === undefined) return {cls:'acc-warn', label:'GPS: unknown'};
  if (meters <= 30) return {cls:'acc-good', label:`GPS: ±${Math.round(meters)}m`};
  if (meters <= 100) return {cls:'acc-warn', label:`GPS: ±${Math.round(meters)}m (weak)`};
  return {cls:'acc-bad', label:`GPS: ±${Math.round(meters)}m (poor)`};
}

function requestLocation(){
  document.getElementById('cityLabel').textContent = 'Locating…';
  if (!('geolocation' in navigator)) {
    document.getElementById('cityLabel').textContent = 'Geolocation not supported by this browser';
    document.getElementById('accuracyPill').textContent = 'GPS: unavailable';
    document.getElementById('accuracyPill').className = 'accuracy-pill acc-bad';
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos)=>{
      state.lat = pos.coords.latitude;
      state.lon = pos.coords.longitude;
      state.gpsAccuracyMeters = pos.coords.accuracy;
      document.getElementById('coordsLabel').textContent =
        `${state.lat.toFixed(4)}°, ${state.lon.toFixed(4)}°`;
      const acc = classifyAccuracy(state.gpsAccuracyMeters);
      const pill = document.getElementById('accuracyPill');
      pill.textContent = acc.label;
      pill.className = 'accuracy-pill ' + acc.cls;

      // We do NOT call any geocoding API here (would require network +
      // an API key we don't have configured), so we're explicit that
      // the "city" shown is just coordinates unless reverse geocoding
      // is wired up server-side.
      document.getElementById('cityLabel').textContent = 'Current location (coordinates only — no reverse geocoding configured)';

      computeSunData();
    },
    (err)=>{
      document.getElementById('cityLabel').textContent = 'Location permission denied or unavailable';
      document.getElementById('accuracyPill').textContent = 'GPS: error';
      document.getElementById('accuracyPill').className = 'accuracy-pill acc-bad';
      document.getElementById('dataNote').textContent =
        'Could not get your location (' + err.message + '). Sunrise/sunset cannot be calculated without coordinates — this is not a guessed fallback.';
    },
    { enableHighAccuracy:true, timeout:10000, maximumAge:60000 }
  );
}
document.getElementById('refreshBtn').addEventListener('click', requestLocation);

// ---------- sun calculations (real SunCalc) ----------
function computeSunData(){
  if (state.lat === null || state.lon === null) return;
  if (typeof SunCalc === 'undefined') {
    document.getElementById('dataNote').textContent =
      'SunCalc library failed to load (no network access to CDN) — cannot compute real sun times.';
    return;
  }

  const today = new Date();
  const times = SunCalc.getTimes(today, state.lat, state.lon);
  const sunrisePos = SunCalc.getPosition(times.sunrise, state.lat, state.lon);
  const sunsetPos  = SunCalc.getPosition(times.sunset, state.lat, state.lon);

  state.today = {
    sunrise: times.sunrise,
    sunset: times.sunset,
    sunriseAz: azToCompassBearing(sunrisePos.azimuth),
    sunsetAz: azToCompassBearing(sunsetPos.azimuth),
  };

  renderToday();
  positionMarkers();
  renderAR();
  buildForecast();

  // Now that location is known, recompute the sky preview (it may have
  // already rendered an "unavailable" message if the picker fired before
  // GPS resolved).
  if (document.getElementById('previewDate') && document.getElementById('previewDate').value) {
    computePreview('previewDate', 'previewTime', null);
  }
  if (document.getElementById('previewDateAr') && document.getElementById('previewDateAr').value) {
    computePreview('previewDateAr', 'previewTimeAr', 'previewResultAr');
  }
}

function renderToday(){
  if (!state.today) return;
  document.getElementById('sunriseTime').textContent = fmtTime(state.today.sunrise);
  document.getElementById('sunsetTime').textContent = fmtTime(state.today.sunset);
  document.getElementById('sunriseAz').textContent = 'Az ' + fmtAz(state.today.sunriseAz);
  document.getElementById('sunsetAz').textContent = 'Az ' + fmtAz(state.today.sunsetAz);
  document.getElementById('sunriseAzLabel').textContent = fmtAz(state.today.sunriseAz);
  document.getElementById('sunsetAzLabel').textContent = fmtAz(state.today.sunsetAz);
}

// ---------- 7-day forecast (computed locally, no network needed) ----------
function buildForecast(){
  if (state.lat === null || typeof SunCalc === 'undefined') return;
  const list = document.getElementById('forecastList');
  list.innerHTML = '';
  state.forecastDays = [];

  for (let i=0; i<7; i++){
    const d = new Date();
    d.setDate(d.getDate()+i);
    const times = SunCalc.getTimes(d, state.lat, state.lon);
    const sunrisePos = SunCalc.getPosition(times.sunrise, state.lat, state.lon);
    const sunsetPos = SunCalc.getPosition(times.sunset, state.lat, state.lon);
    const entry = {
      date: d,
      sunrise: times.sunrise,
      sunset: times.sunset,
      sunriseAz: azToCompassBearing(sunrisePos.azimuth),
      sunsetAz: azToCompassBearing(sunsetPos.azimuth),
    };
    state.forecastDays.push(entry);

    const row = document.createElement('div');
    row.className = 'forecast-row';
    row.innerHTML = `
      <div class="forecast-date">${shortDate(d)}<strong>${dayNum(d)} ${monthShort(d)}</strong></div>
      <div class="forecast-times">
        <div class="fcol">
          <span class="ftime">${fmtTime(entry.sunrise)}</span>
          <span class="faz">○ ${fmtAz(entry.sunriseAz)}</span>
        </div>
        <div class="fcol">
          <span class="ftime">${fmtTime(entry.sunset)}</span>
          <span class="faz">● ${fmtAz(entry.sunsetAz)}</span>
        </div>
      </div>`;
    list.appendChild(row);
  }
}
function renderForecast(){
  // re-render with current time format without recomputing astronomy
  if (state.forecastDays.length) buildForecast();
}

// ---------- compass ticks (drawn once) ----------
function drawTicks(){
  const dial = document.getElementById('compassDial');
  for (let deg=0; deg<360; deg+=10){
    const tick = document.createElement('div');
    tick.className = 'tick' + (deg % 30 === 0 ? ' major' : '');
    tick.style.transform = `rotate(${deg}deg)`;
    dial.insertBefore(tick, dial.firstChild);
  }
}

// ---------- positioning sun markers on dial relative to heading ----------
function positionMarkers(){
  if (!state.today) return;
  const heading = state.heading ?? 0; // if no sensor, dial assumes "up = current heading unknown, default 0/N"
  const sunriseAngle = state.today.sunriseAz - heading;
  const sunsetAngle = state.today.sunsetAz - heading;

  document.getElementById('sunriseMarker').style.transform = `rotate(${sunriseAngle}deg)`;
  document.getElementById('sunsetMarker').style.transform = `rotate(${sunsetAngle}deg)`;

  // counter-rotate labels so text stays upright
  document.getElementById('sunriseMarker').querySelector('.dot-ring').style.transform =
    `translate(-65px,-148px) rotate(${-sunriseAngle}deg)`;
  document.getElementById('sunsetMarker').querySelector('.dot-ring').style.transform =
    `translate(-65px,-148px) rotate(${-sunsetAngle}deg)`;
}

// rotate whole dial opposite to heading so "N" tracks real north visually
function rotateDial(){
  const dial = document.getElementById('compassDial');
  const heading = state.heading ?? 0;
  dial.style.transform = `rotate(${-heading}deg)`;
}

// ---------- device orientation (real compass sensor) ----------
let orientationActive = false;

function handleOrientation(event){
  let heading = null;
  if (event.webkitCompassHeading !== undefined && event.webkitCompassHeading !== null) {
    // iOS Safari: already a compass heading (0 = North), no need to invert
    heading = event.webkitCompassHeading;
    state.headingSource = 'webkit';
  } else if (event.absolute && event.alpha !== null) {
    heading = 360 - event.alpha;
    state.headingSource = 'absolute';
  } else if (event.alpha !== null) {
    // Non-absolute alpha is relative to initial device position, not true north.
    // We still show it but label it clearly as uncalibrated/relative.
    heading = 360 - event.alpha;
    state.headingSource = 'relative-uncalibrated';
  }

  // ---- pitch (tilt up/down), used to move the AR sun marker vertically ----
  // Per the W3C DeviceOrientationEvent spec: when a phone is held upright
  // in portrait, screen facing the user, beta is approximately 90°
  // regardless of heading. Tilting the top of the phone backward (camera
  // pointing up at the sky) DECREASES beta below 90; tilting forward
  // (camera pointing down) INCREASES it above 90.
  // So: degrees-above-the-horizon-the-camera-points ≈ 90 − beta.
  //
  // KNOWN LIMITATION, stated plainly: this formula is verified against
  // the W3C spec for the common case (portrait, screen facing the user).
  // It has NOT been tested on a real device by me — iOS vs Android and
  // portrait vs landscape are known sources of inconsistency in this
  // exact API (this is the same category of bug that affected Google's
  // own Sky Map for years). If the sun moves the WRONG direction when
  // you tilt, that's a sign this sign needs flipping for your device —
  // tell me what you observe and I'll correct it from real feedback
  // rather than guessing further.
  if (event.beta !== null && event.beta !== undefined) {
    state.pitch = 90 - event.beta;
  }

  if (heading !== null) {
    state.heading = (heading + 360) % 360;
    orientationActive = true;
    updateCompassCaption();
    rotateDial();
    positionMarkers();
    renderAR();
    updateAlignmentBanners();
  } else if (event.beta !== null && event.beta !== undefined) {
    // Heading didn't update this event, but pitch did — still refresh
    // AR so vertical sun position stays live even if alpha is momentarily
    // unavailable.
    renderAR();
  }
}

// ---------- "facing the sun" alignment banners ----------
// Tolerance is intentionally tight (±5°) per explicit request. Note this is
// close to or below the real-world accuracy of many phone magnetometers,
// so on some devices this may flicker near the edge of the range — that's
// a hardware/sensor limitation, not a logic bug in this function.
const ALIGNMENT_TOLERANCE_DEG = 5;

// Shortest signed angular distance from `a` to `b`, result in [-180, 180].
function angularDelta(a, b){
  return ((b - a + 540) % 360) - 180;
}

function updateAlignmentBanners(){
  if (!state.today || state.heading === null) return;

  const riseDelta = Math.abs(angularDelta(state.heading, state.today.sunriseAz));
  const setDelta = Math.abs(angularDelta(state.heading, state.today.sunsetAz));

  let bannerHtml = null;
  let bannerClass = null;

  // If both happen to be within tolerance at once (only possible for
  // locations/dates where sunrise and sunset azimuths are very close
  // together), prefer whichever is more precisely aligned.
  if (riseDelta <= ALIGNMENT_TOLERANCE_DEG && setDelta <= ALIGNMENT_TOLERANCE_DEG) {
    if (riseDelta <= setDelta) {
      bannerHtml = `○ Facing Sunrise — ${fmtTime(state.today.sunrise)}`;
      bannerClass = 'sunrise-align';
    } else {
      bannerHtml = `● Facing Sunset — ${fmtTime(state.today.sunset)}`;
      bannerClass = 'sunset-align';
    }
  } else if (riseDelta <= ALIGNMENT_TOLERANCE_DEG) {
    bannerHtml = `○ Facing Sunrise — ${fmtTime(state.today.sunrise)}`;
    bannerClass = 'sunrise-align';
  } else if (setDelta <= ALIGNMENT_TOLERANCE_DEG) {
    bannerHtml = `● Facing Sunset — ${fmtTime(state.today.sunset)}`;
    bannerClass = 'sunset-align';
  }

  [ 'homeAlignBanner', 'arAlignBanner' ].forEach(id=>{
    const el = document.getElementById(id);
    if (!el) return;
    if (bannerHtml){
      el.textContent = bannerHtml;
      el.className = el.id === 'arAlignBanner'
        ? `align-banner align-banner-ar ${bannerClass}`
        : `align-banner ${bannerClass}`;
      el.style.display = 'flex';
    } else {
      el.style.display = 'none';
    }
  });
}

function updateCompassCaption(){
  const cap = document.getElementById('compassCaption');
  if (!orientationActive) {
    cap.textContent = 'Compass: sensor not active';
    return;
  }
  if (state.headingSource === 'relative-uncalibrated') {
    cap.textContent = `Heading ${Math.round(state.heading)}° — uncalibrated/relative (browser did not report absolute orientation)`;
  } else {
    cap.textContent = `Heading ${Math.round(state.heading)}° (${state.headingSource})`;
  }
}

async function enableCompass(){
  if (typeof DeviceOrientationEvent === 'undefined') {
    document.getElementById('compassCaption').textContent = 'Compass: DeviceOrientationEvent not supported on this browser/device';
    return;
  }
  // iOS 13+ requires an explicit permission request triggered by a user gesture
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    try {
      const result = await DeviceOrientationEvent.requestPermission();
      if (result !== 'granted') {
        document.getElementById('compassCaption').textContent = 'Compass: permission denied';
        return;
      }
    } catch (e) {
      document.getElementById('compassCaption').textContent = 'Compass: permission request failed — ' + e.message;
      return;
    }
  }
  window.addEventListener('deviceorientationabsolute', handleOrientation, true);
  window.addEventListener('deviceorientation', handleOrientation, true);
  document.getElementById('compassCaption').textContent = 'Compass: listening for sensor data…';
}

// Try enabling automatically (works on Android Chrome without a gesture-gated prompt);
// iOS requires the calibrate button tap below since it needs a user gesture.
enableCompass();

document.getElementById('calibBtn').addEventListener('click', async ()=>{
  await enableCompass();
  state.calibrated = true;
  document.getElementById('calibStatus').textContent = 'Calibration requested — move phone in a figure‑8';
});
document.getElementById('arCalibBtn').addEventListener('click', async ()=>{
  await enableCompass();
});

// ---------- AR mode marker positioning ----------
async function enableARCamera(){
  const view = document.getElementById('arView');
  if (!('mediaDevices' in navigator) || !navigator.mediaDevices.getUserMedia) {
    document.getElementById('arCameraBtn').textContent = 'Camera not supported';
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' } });
    let video = view.querySelector('video');
    if (!video){
      video = document.createElement('video');
      video.autoplay = true; video.playsInline = true; video.muted = true;
      view.insertBefore(video, view.firstChild);
    }
    video.srcObject = stream;
    document.getElementById('arCameraBtn').textContent = 'Camera on';
  } catch(e) {
    document.getElementById('arCameraBtn').textContent = 'Camera permission denied';
  }
}
document.getElementById('arCameraBtn').addEventListener('click', enableARCamera);

function renderAR(){
  if (!state.today) return;
  document.getElementById('arSunriseTime').textContent = 'Sunrise ' + fmtTime(state.today.sunrise);
  document.getElementById('arSunsetTime').textContent = 'Sunset ' + fmtTime(state.today.sunset);

  // Horizon line itself must move with real pitch too, or it will visually
  // disagree with the now-pitch-aware sun markers. 0° pitch (camera level
  // with the true horizon) puts the line at screen center; tilting the
  // phone up moves the horizon line down on screen, and vice versa —
  // same convention as the marker math below.
  const horizonEl = document.querySelector('.ar-horizon');
  if (horizonEl) {
    const fovV = 70;
    const horizonTopPct = state.pitch === null
      ? 60  // fallback to the original fixed placement until pitch is known
      : Math.max(-20, Math.min(120, 50 + (state.pitch / fovV) * 50));
    horizonEl.style.top = horizonTopPct + '%';
  }

  const pitchEl = document.getElementById('pitchReadout');
  if (pitchEl) {
    pitchEl.textContent = state.pitch === null
      ? 'Tilt: waiting for sensor…'
      : `Tilt: ${state.pitch >= 0 ? '+' : ''}${state.pitch.toFixed(0)}°`;
  }

  const heading = state.heading ?? 0;
  // Map azimuth delta to horizontal screen position.
  // Assume a ~90° horizontal field of view for the mock camera frame.
  const fovH = 90;
  function angleToLeftPercent(targetAz){
    let delta = ((targetAz - heading + 540) % 360) - 180; // -180..180
    const pct = 50 + (delta / fovH) * 50;
    return Math.max(-20, Math.min(120, pct)); // allow sliding off-screen a bit
  }

  // Map altitude (sun's real height above horizon) against pitch (how
  // far up/down the phone is currently tilted) to a vertical screen
  // position. When pitch is unavailable (sensor hasn't reported beta
  // yet, or device doesn't support it), fall back to a fixed mid-height
  // placement rather than guessing — this matches the app's existing
  // policy of showing "--" / a clear fallback instead of inventing data.
  const fovV = 70; // vertical field of view assumed for the mock camera frame
  function altitudeToTopPercent(altitudeDeg){
    if (state.pitch === null) {
      // No real pitch data yet — keep the previous fixed placement so
      // the marker doesn't jump to a meaningless position.
      return 62;
    }
    const delta = altitudeDeg - state.pitch; // positive = sun is above where camera points
    const pct = 50 - (delta / fovV) * 50; // screen "up" = smaller top%, hence the minus
    return Math.max(-20, Math.min(120, pct));
  }

  const riseLeft = angleToLeftPercent(state.today.sunriseAz);
  const setLeft = angleToLeftPercent(state.today.sunsetAz);
  // Sunrise/sunset markers represent the horizon-crossing moment, i.e.
  // altitude = 0° by definition — that's real, not a placeholder.
  const riseTop = altitudeToTopPercent(0);
  const setTop = altitudeToTopPercent(0);

  document.getElementById('arSunrise').style.left = riseLeft + '%';
  document.getElementById('arSunrise').style.top = riseTop + '%';
  document.getElementById('arSunrise').style.bottom = 'auto';
  document.getElementById('arSunrise').style.display =
    (riseLeft >= -15 && riseLeft <= 115 && riseTop >= -15 && riseTop <= 115) ? 'flex' : 'none';

  document.getElementById('arSunset').style.left = setLeft + '%';
  document.getElementById('arSunset').style.top = setTop + '%';
  document.getElementById('arSunset').style.bottom = 'auto';
  document.getElementById('arSunset').style.display =
    (setLeft >= -15 && setLeft <= 115 && setTop >= -15 && setTop <= 115) ? 'flex' : 'none';

  renderPreviewAR();
}

// =========================================================
// Date/time PREVIEW feature — "sky view"
//
// This computes the sun's REAL azimuth and altitude for any
// date/time the user picks, using the same SunCalc.getPosition()
// call already used elsewhere — not a guessed or hardcoded value.
//
// The date/time picker is always active (no on/off toggle) and
// drives:
//   1. A glowing sun rendered in a dedicated sky panel on Home,
//      positioned left-right by azimuth (relative to current
//      compass heading) and up-down by altitude.
//   2. The sky panel's background gradient, which shifts based on
//      real solar altitude using standard astronomical twilight
//      thresholds (these are recognized terms, not invented bands):
//        altitude >= 0°        : day
//        0° to -6°             : civil twilight
//        -6° to -18°           : nautical/astronomical twilight
//        below -18°            : night
//   3. A dashed "ghost" marker on the compass dial (azimuth only —
//      the dial is flat and can't show altitude without faking a
//      3D effect, so altitude stays as a text readout there).
//   4. The AR screen's marker + background, same altitude/azimuth
//      mapping as the sky panel.
// =========================================================

function getPreviewDateTimeLocal(dateInputId, timeInputId){
  const dateVal = document.getElementById(dateInputId).value;   // 'YYYY-MM-DD'
  const timeVal = document.getElementById(timeInputId).value;   // 'HH:MM'
  if (!dateVal || !timeVal) return null;
  const dt = new Date(`${dateVal}T${timeVal}:00`);
  if (isNaN(dt.getTime())) return null;
  return dt;
}

// Returns a CSS gradient string for a given solar altitude (degrees),
// using real astronomical twilight thresholds rather than arbitrary
// color picking. Interpolates smoothly between named bands.
function skyGradientForAltitude(altitudeDeg){
  const bands = [
    { alt: 15,  grad: 'linear-gradient(180deg,#2a6fd1 0%, #8fcbff 60%, #ffe9c4 100%)' }, // full day
    { alt: 0,   grad: 'linear-gradient(180deg,#3a5a8c 0%, #e8966b 65%, #ffd9a0 100%)' }, // sunrise/sunset band
    { alt: -6,  grad: 'linear-gradient(180deg,#1c2a4a 0%, #7a4f6b 65%, #c97a5a 100%)' }, // civil twilight
    { alt: -18, grad: 'linear-gradient(180deg,#070b18 0%, #1c2540 70%, #2e2a4a 100%)' }, // nautical/astro twilight
    { alt: -90, grad: 'linear-gradient(180deg,#04050c 0%, #0a0f1c 100%)' },              // night
  ];
  if (altitudeDeg >= bands[0].alt) return bands[0].grad;
  if (altitudeDeg <= bands[bands.length-1].alt) return bands[bands.length-1].grad;
  // Find which band range we're inside. bands[i] is the UPPER bound of a
  // range and bands[i+1] is the LOWER bound — the gradient that applies
  // is bands[i+1]'s (the band whose range we're currently inside),
  // not bands[i]'s (that would label band by its ceiling, not its content).
  for (let i=0; i<bands.length-1; i++){
    if (altitudeDeg <= bands[i].alt && altitudeDeg > bands[i+1].alt){
      return bands[i+1].grad;
    }
  }
  return bands[bands.length-1].grad;
}

function computePreview(dateInputId, timeInputId, resultElId){
  const resultEl = document.getElementById(resultElId);
  if (state.lat === null || state.lon === null || typeof SunCalc === 'undefined') {
    if (resultEl) {
      resultEl.innerHTML = '<span class="preview-warn">Location not available yet — cannot compute sky position.</span>';
    }
    state.previewResult = null;
    renderSkyView();
    positionPreviewMarker();
    renderPreviewAR();
    return;
  }

  const dt = getPreviewDateTimeLocal(dateInputId, timeInputId);
  if (!dt) {
    state.previewResult = null;
    renderSkyView();
    positionPreviewMarker();
    renderPreviewAR();
    return;
  }

  // SunCalc.getPosition wants a Date object — a JS Date constructed from
  // local "YYYY-MM-DDTHH:MM:00" is already correctly anchored to the
  // browser's local timezone, so this is real, not a guess.
  const pos = SunCalc.getPosition(dt, state.lat, state.lon);
  const azimuth = azToCompassBearing(pos.azimuth);
  const altitudeDeg = pos.altitude * 180 / Math.PI;

  state.previewResult = { azimuth, altitudeDeg, dateTime: dt };

  if (resultEl) {
    if (altitudeDeg < 0) {
      resultEl.innerHTML =
        `Az ${fmtAz(azimuth)} · Altitude ${altitudeDeg.toFixed(1)}° ` +
        `<span class="preview-warn">(below horizon — not visible at this time)</span>`;
    } else {
      resultEl.innerHTML = `Az ${fmtAz(azimuth)} · Altitude ${altitudeDeg.toFixed(1)}° above horizon`;
    }
  }

  renderSkyView();
  positionPreviewMarker();
  renderPreviewAR();
}

// Renders the Home screen's dedicated sky panel: gradient backdrop
// (by altitude) + a glowing sun positioned by azimuth (relative to
// current heading, left-right) and altitude (up-down).
function renderSkyView(){
  const view = document.getElementById('skyView');
  const sun = document.getElementById('skySun');
  const glow = document.getElementById('skySunGlow');
  const readout = document.getElementById('skyReadout');
  if (!view) return;

  if (!state.previewResult) {
    readout.textContent = 'Pick a date and time to preview the sky.';
    sun.style.display = 'none';
    glow.style.display = 'none';
    return;
  }

  const { azimuth, altitudeDeg, dateTime } = state.previewResult;
  view.style.background = skyGradientForAltitude(altitudeDeg);

  const heading = state.heading ?? 0;
  const fov = 100; // wider than AR's 90° since this is a standalone panel, not a camera FOV
  const delta = ((azimuth - heading + 540) % 360) - 180;
  const leftPct = Math.max(-5, Math.min(105, 50 + (delta / fov) * 50));

  // 0° altitude sits on the horizon line (70% down, matching .sky-horizon-line),
  // 90° (straight overhead) moves to near the top. Simplified linear mapping,
  // not a true perspective projection.
  const horizonPct = 70;
  const topPct = Math.max(6, horizonPct - (Math.max(0, altitudeDeg) / 90) * (horizonPct - 8));
  // Below the horizon, let the sun sink visually rather than vanish abruptly,
  // capped so it doesn't run off the bottom of the panel.
  const belowPct = Math.min(96, horizonPct + (Math.max(0, -altitudeDeg) / 30) * (96 - horizonPct));
  const finalTopPct = altitudeDeg >= 0 ? topPct : belowPct;

  const visible = leftPct >= -5 && leftPct <= 105;
  sun.style.display = visible ? 'block' : 'none';
  glow.style.display = (visible && altitudeDeg >= -2) ? 'block' : 'none';
  sun.style.left = leftPct + '%';
  sun.style.top = finalTopPct + '%';
  glow.style.left = leftPct + '%';
  glow.style.top = finalTopPct + '%';
  sun.style.opacity = altitudeDeg < -2 ? '0.35' : '1';

  readout.textContent =
    `${fmtTime(dateTime)} · Az ${fmtAz(azimuth)} · Alt ${altitudeDeg.toFixed(1)}°` +
    (altitudeDeg < 0 ? ' (below horizon)' : '');
}

function positionPreviewMarker(){
  const marker = document.getElementById('previewMarker');
  if (!marker) return;
  if (!state.previewResult) {
    marker.style.display = 'none';
    return;
  }
  const heading = state.heading ?? 0;
  const angle = state.previewResult.azimuth - heading;
  marker.style.display = 'block';
  marker.style.transform = `rotate(${angle}deg)`;
  marker.querySelector('.dot-ring').style.transform = `translate(-65px,-148px) rotate(${-angle}deg)`;
  document.getElementById('previewAzLabel').textContent = fmtAz(state.previewResult.azimuth);
}

function renderPreviewAR(){
  const marker = document.getElementById('arPreview');
  const skyBg = document.getElementById('arSkyBg');
  if (!marker) return;
  if (!state.previewResult) {
    marker.style.display = 'none';
    return;
  }

  if (skyBg) {
    skyBg.style.background = skyGradientForAltitude(state.previewResult.altitudeDeg);
  }

  const heading = state.heading ?? 0;
  const fov = 90;
  let delta = ((state.previewResult.azimuth - heading + 540) % 360) - 180;
  const leftPct = Math.max(-20, Math.min(120, 50 + (delta / fov) * 50));

  // Same real pitch-based vertical mapping used for the live sunrise/
  // sunset markers in renderAR() — uses the phone's actual measured
  // tilt (state.pitch) rather than a fixed horizon assumption, so this
  // ghost marker moves correctly as you tilt the phone, same as the
  // live markers now do.
  const altitudeDeg = state.previewResult.altitudeDeg;
  const fovV = 70;
  let topPct;
  if (state.pitch === null) {
    topPct = 62; // no real pitch data yet — fixed fallback, not a guess dressed as data
  } else {
    const vDelta = altitudeDeg - state.pitch;
    topPct = Math.max(-20, Math.min(120, 50 - (vDelta / fovV) * 50));
  }

  marker.style.left = leftPct + '%';
  marker.style.top = topPct + '%';
  marker.style.bottom = 'auto';
  marker.style.display = (leftPct >= -15 && leftPct <= 115 && altitudeDeg >= -5) ? 'flex' : 'none';

  document.getElementById('arPreviewTime').textContent =
    'Preview ' + fmtTime(state.previewResult.dateTime);
}

function wirePreviewControls(dateId, timeId, resultId, nowBtnId){
  const dateInput = document.getElementById(dateId);
  const timeInput = document.getElementById(timeId);
  const nowBtn = document.getElementById(nowBtnId);

  function setToNow(){
    const now = new Date();
    dateInput.value = now.toISOString().slice(0,10);
    timeInput.value = now.toTimeString().slice(0,5);
    computePreview(dateId, timeId, resultId);
  }

  setToNow(); // sensible starting point

  dateInput.addEventListener('change', ()=> computePreview(dateId, timeId, resultId));
  timeInput.addEventListener('change', ()=> computePreview(dateId, timeId, resultId));
  if (nowBtn) nowBtn.addEventListener('click', setToNow);
}

wirePreviewControls('previewDate', 'previewTime', null, 'previewNowBtn');
wirePreviewControls('previewDateAr', 'previewTimeAr', 'previewResultAr', 'previewNowBtnAr');




// ---------- init ----------
drawTicks();
requestLocation();
