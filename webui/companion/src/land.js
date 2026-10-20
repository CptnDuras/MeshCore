// Who manages the land at a point: the BLM's Surface Management Agency layer (United States only, no key, answers browsers directly).
// It classes land as federal (BLM, Forest Service, Park Service, military ...), state, local government, tribal or "private or unknown".
// It does not know parcels or owners' names, and a private inholding inside public land can read as public. Treat it as a first look, not as permission.
(function (root) {
  'use strict';
  var ENDPOINT = 'https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_LimitedScale/MapServer/1/query';
  var NAMES = { BLM: 'Bureau of Land Management', USFS: 'US Forest Service', NPS: 'National Park Service', FWS: 'US Fish and Wildlife Service', USBR: 'Bureau of Reclamation',
    BIA: 'Bureau of Indian Affairs', DOD: 'Department of Defense', ARMY: 'US Army', NAVY: 'US Navy', USAF: 'US Air Force', USMC: 'US Marine Corps', USACE: 'Army Corps of Engineers',
    DOE: 'Department of Energy', DOI: 'Department of the Interior', DOT: 'Department of Transportation', FAA: 'FAA', FHA: 'Federal Highway Administration', GSA: 'General Services Administration',
    HHS: 'Health and Human Services', NOAA: 'NOAA', USCG: 'US Coast Guard', USDA: 'US Department of Agriculture', USPS: 'US Postal Service', VA: 'Veterans Affairs', BOP: 'Bureau of Prisons',
    BPA: 'Bonneville Power Administration', OTHFE: 'Other federal', ST: 'State', LG: 'Local government', NTVALL: 'Alaska Native allotment', NTVPIC: 'Alaska Native land',
    PVT: 'Private or unknown', UND: 'Undetermined' };
  var cache = {};

  // -> { cls: 'federal' | 'state' | 'local' | 'tribal' | 'private' | 'unknown', code, name, label }
  function classOf(code) {
    if (!code) return 'unknown';
    if (code === 'PVT') return 'private';
    if (code === 'ST') return 'state';
    if (code === 'LG') return 'local';
    if (code === 'NTVALL' || code === 'NTVPIC' || code === 'BIA') return 'tribal';
    if (code === 'UND') return 'unknown';
    return 'federal';
  }
  function describe(code) {
    var cls = classOf(code), name = NAMES[code] || code || 'No data';
    var kind = { federal: 'Federal land', state: 'State land', local: 'Local government land', tribal: 'Tribal / Native land', private: 'Private or unknown', unknown: 'Unknown' }[cls];
    return { cls: cls, code: code || null, name: name, label: cls === 'federal' ? kind + ' · ' + name : kind };
  }
  function isPublic(info) { return !!info && (info.cls === 'federal' || info.cls === 'state' || info.cls === 'local'); }

  async function at(lat, lon) {
    var key = lat.toFixed(4) + ',' + lon.toFixed(4);
    if (cache[key]) return cache[key];
    var q = ENDPOINT + '?f=json&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=ADMIN_AGENCY_CODE&returnGeometry=false&geometry=' + lon + ',' + lat;
    cache[key] = fetch(q).then(function (r) {
      if (!r.ok) throw new Error('land lookup answered ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.error) throw new Error(j.error.message || 'land lookup failed');
      var f = (j.features || [])[0];
      return f ? describe(f.attributes.ADMIN_AGENCY_CODE) : Object.assign(describe(null), { label: 'No data here (the land data covers the United States)' });
    }).catch(function (e) { delete cache[key]; return Object.assign(describe(null), { label: 'Could not look this up (' + e.message + ')', failed: true }); });
    return cache[key];
  }

  root.Land = { at: at, describe: describe, isPublic: isPublic, classOf: classOf, names: NAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.Land;
})(typeof self !== 'undefined' ? self : this);
