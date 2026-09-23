// Place and address search.
//
// Two free, keyless geocoders run side by side:
// - US Census Geocoder: street addresses, including rural county-road
//   addresses that OpenStreetMap often lacks. It sends no CORS headers, so it
//   is called through JSONP.
// - Photon (https://photon.komoot.io): OpenStreetMap places, peaks, towns and
//   addresses worldwide, built for search-as-you-type.

const PHOTON_URL = 'https://photon.komoot.io/api/';
const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const CENSUS_TIMEOUT_MS = 8000;

// "39.1175, -106.4453" style coordinates.
function parseLatLng(q) {
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

// A house number followed by a street is worth sending to the Census geocoder.
const looksLikeAddress = (q) => /^\d+[a-z]?\s+\S+/i.test(q);

const titleCase = (s) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

let jsonpId = 0;
function jsonp(url, signal) {
  return new Promise((resolve, reject) => {
    const cb = `__geocode${++jsonpId}`;
    const script = document.createElement('script');
    const cleanup = () => {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    };
    const timer = setTimeout(() => (cleanup(), reject(new Error('timeout'))), CENSUS_TIMEOUT_MS);
    signal.addEventListener('abort', () => (cleanup(), reject(new DOMException('aborted', 'AbortError'))));
    window[cb] = (data) => (cleanup(), resolve(data));
    script.onerror = () => (cleanup(), reject(new Error('network')));
    script.src = `${url}&callback=${cb}`;
    document.head.append(script);
  });
}

async function censusSearch(q, signal) {
  const params = new URLSearchParams({ address: q, benchmark: 'Public_AR_Current', format: 'jsonp' });
  const data = await jsonp(`${CENSUS_URL}?${params}`, signal);
  return data.result.addressMatches.map((m) => {
    // "224 MADISON 2425, HUNTSVILLE, AR, 72740"
    const [street, ...rest] = m.matchedAddress.split(', ');
    return {
      title: titleCase(street),
      sub: [titleCase(rest[0] || ''), rest.slice(1).join(' ')].filter(Boolean).join(', '),
      center: [m.coordinates.x, m.coordinates.y],
      precise: true,
    };
  });
}

function describePhoton(p) {
  const street = [p.housenumber, p.street].filter(Boolean).join(' ');
  const title = p.name || street || p.city || p.county || p.state || 'Unnamed place';
  const sub = [p.name && street, p.city !== title && p.city, p.state, p.countrycode !== 'US' && p.country]
    .filter(Boolean)
    .join(', ');
  return { title, sub };
}

async function photonSearch(q, near, signal) {
  const params = new URLSearchParams({ q, limit: '6', lang: 'en', lat: near.lat.toFixed(3), lon: near.lng.toFixed(3) });
  const r = await fetch(`${PHOTON_URL}?${params}`, { signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  return data.features.map((f) => ({
    ...describePhoton(f.properties),
    center: f.geometry.coordinates,
    extent: f.properties.extent, // [west, north, east, south]
    precise: ['house', 'street'].includes(f.properties.type),
  }));
}

/**
 * Wires the search form. `onPick(result)` receives { title, sub, center, extent?, precise }.
 */
export function initSearch({ form, input, list, getCenter, onPick }) {
  let results = [];
  let selected = -1;
  let resultsQuery = null; // the query `results` belong to
  let timer;
  let abort;
  let inflight = null; // { q, done } for the search currently running

  const setExpanded = (on) => {
    list.hidden = !on;
    input.setAttribute('aria-expanded', String(on));
  };
  const highlight = () => [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === selected)));

  function show(items, emptyText) {
    results = items;
    selected = items.length ? 0 : -1;
    const rows = items.length ? items : [{ title: emptyText }];
    list.replaceChildren(
      ...rows.map((res, i) => {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = res.title;
        if (res.sub) li.append(Object.assign(document.createElement('span'), { className: 'sub', textContent: res.sub }));
        if (items.length) li.addEventListener('mousedown', (e) => (e.preventDefault(), pick(results[i])));
        return li;
      }),
    );
    highlight();
    setExpanded(true);
  }

  // Shows Photon results as soon as they arrive and puts Census address
  // matches on top when those come back.
  async function search(q) {
    abort?.abort();
    abort = new AbortController();
    const { signal } = abort;
    let photon = [];
    let census = [];
    const total = looksLikeAddress(q) ? 2 : 1;
    let pending = total;
    let failures = 0;
    const update = () => {
      if (signal.aborted) return;
      resultsQuery = q;
      const merged = [...census, ...photon];
      if (merged.length) show(merged);
      else if (pending === 0) show([], failures === total ? 'Search is unavailable right now' : 'No matches');
    };
    const run = (p, set) =>
      p.then(set, (e) => {
        if (e.name !== 'AbortError') failures++;
      }).finally(() => {
        pending--;
        update();
      });
    const jobs = [run(photonSearch(q, getCenter(), signal), (r) => (photon = r))];
    if (looksLikeAddress(q)) jobs.push(run(censusSearch(q, signal), (r) => (census = r)));
    inflight = { q, done: Promise.all(jobs) };
    await inflight.done;
  }

  function pick(res) {
    setExpanded(false);
    input.value = res.sub ? `${res.title}, ${res.sub}` : res.title;
    input.blur();
    onPick(res);
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    const ll = parseLatLng(q);
    if (ll) {
      resultsQuery = q;
      return show([{ title: `${ll.lat}, ${ll.lng}`, center: [ll.lng, ll.lat], precise: true }]);
    }
    if (q.length < 3) return setExpanded(false);
    // The Census geocoder is slower and not built for per-keystroke use.
    timer = setTimeout(() => search(q), looksLikeAddress(q) ? 500 : 250);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      highlight();
    } else if (e.key === 'Escape') {
      setExpanded(false);
    }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    const ll = parseLatLng(q);
    if (ll) return pick({ title: q, center: [ll.lng, ll.lat], precise: true });
    // Wait for every geocoder so an address match can win over a place match.
    if (inflight?.q === q) await inflight.done;
    else if (resultsQuery !== q || !results.length) {
      clearTimeout(timer);
      await search(q);
    }
    if (results[selected]) pick(results[selected]);
  });

  input.addEventListener('blur', () => setExpanded(false));
}
