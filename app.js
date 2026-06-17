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

  if (heading !== null) {
    state.heading = (heading + 360) % 360;
    orientationActive = true;
    updateCompassCaption();
    rotateDial();
    positionMarkers();
    renderAR();
    updateAlignmentBanners();
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

  const heading = state.heading ?? 0;
  // Map azimuth delta to horizontal screen position.
  // Assume a ~90° horizontal field of view for the mock camera frame.
  const fov = 90;
  function angleToLeftPercent(targetAz){
    let delta = ((targetAz - heading + 540) % 360) - 180; // -180..180
    const pct = 50 + (delta / fov) * 50;
    return Math.max(-20, Math.min(120, pct)); // allow sliding off-screen a bit
  }
  const riseLeft = angleToLeftPercent(state.today.sunriseAz);
  const setLeft = angleToLeftPercent(state.today.sunsetAz);

  document.getElementById('arSunrise').style.left = riseLeft + '%';
  document.getElementById('arSunrise').style.bottom = '38%';
  document.getElementById('arSunrise').style.top = 'auto';
  document.getElementById('arSunrise').style.display = (riseLeft >= -15 && riseLeft <= 115) ? 'flex' : 'none';

  document.getElementById('arSunset').style.left = setLeft + '%';
  document.getElementById('arSunset').style.bottom = '38%';
  document.getElementById('arSunset').style.top = 'auto';
  document.getElementById('arSunset').style.display = (setLeft >= -15 && setLeft <= 115) ? 'flex' : 'none';
}

// ---------- init ----------
drawTicks();
requestLocation();
