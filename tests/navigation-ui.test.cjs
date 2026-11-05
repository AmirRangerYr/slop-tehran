const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

// The Navigate menu and the full map's tap menu (js/navigation-ui.js) on a small stand-in DOM: one menu for every way
// to go (drive yourself, self-driving, Crazy Taxi, teleport), from the place list or from a tap on the map
const source = readFileSync(join(__dirname, '../js/navigation-ui.js'), 'utf8');

function element(attrs = {}) {
  const listeners = new Map();
  const children = [];
  const el = {
    hidden: false, style: {}, dataset: {}, textContent: '', offsetWidth: 220, offsetHeight: 200, children,
    classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, toggle(c, on) { if (on) this.set.add(c); else this.set.delete(c); }, contains(c) { return this.set.has(c); } },
    setAttribute(k, v) { this[k] = v; },
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
    dispatch(type, e = {}) { for (const fn of listeners.get(type) || []) fn(e); },
    click() { el.dispatch('click'); },
    append(...c) { children.push(...c); },
    appendChild(c) { children.push(c); return c; },
    querySelector(sel) { return el.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const m = /^\[data-([a-z]+)(?:="([^"]+)")?\]$/.exec(sel);
      if (sel === 'use') return [el.useEl || (el.useEl = element())];
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (m && c.dataset[m[1]] !== undefined && (m[2] === undefined || c.dataset[m[1]] === m[2])) out.push(c);
          walk(c);
        }
      };
      walk(el);
      return out;
    },
    ...attrs
  };
  return el;
}

function harness({ teleportable = true } = {}) {
  const ids = {};
  const byId = (id) => ids[id] || (ids[id] = element());
  const popover = byId('navigate-popover');
  for (const d of ['you', 'self', 'crazy', 'teleport']) {
    const b = element();
    b.dataset.driver = d;
    popover.appendChild(b);
  }
  const pick = byId('map-pick-menu');
  pick.hidden = true;
  for (const g of ['you', 'self', 'crazy', 'teleport']) {
    const b = element();
    b.dataset.go = g;
    pick.appendChild(b);
  }
  const winListeners = element();
  const document = { getElementById: byId, createElement: () => element(), body: element() };
  const window = { innerWidth: 1000, innerHeight: 700, addEventListener: winListeners.addEventListener };
  const places = {
    raffles: { x: 10, z: 20, heading: 1, name: 'Raffles Place', sub: 'CBD' },
    merlion: { x: -30, z: 40, heading: 2, name: 'Merlion Park', sub: 'Marina Bay' }
  };
  const { setupNavigationUI } = loadModule(source, {
    globals: { document, window, setTimeout: () => 0, clearTimeout: () => {}, Math, Object, String, Number },
    imports: { './city-config.js': { NYC_LANDMARKS: Object.values(places), TELEPORT_LOCATIONS: places, CITY: { units: 'metric' } } }
  });
  const calls = [];
  const navigator = {
    driver: { id: 'you', auto: false, label: 'You drive' },
    active: false,
    setDriver(id) { calls.push(['driver', id]); this.driver = { id, auto: id !== 'you', label: id }; },
    setDestination(x, z, name) { calls.push(['destination', x, z, name]); this.active = true; return true; },
    reroute() { calls.push(['reroute']); return true; },
    clear() { this.active = false; },
    state() { return { active: this.active, driver: this.driver.id, driverLabel: this.driver.label }; },
    onChange: null, onEvent: null
  };
  const controllerManager = { activeMode: 'person', getActiveEntity: () => ({ position: { x: 0, z: 0 } }) };
  const fullCanvas = element();
  const mapSystem = {
    fullCanvas, waypoint: null, routeLine: null, pickHandler: null, onPick: null, open: true,
    toggleFullMap(open) { calls.push(['map', open]); this.open = open; },
    renderFullMap() {}
  };
  const ui = setupNavigationUI({
    navigator, mapSystem, controllerManager,
    selectMode: (m) => { calls.push(['mode', m]); controllerManager.activeMode = m; },
    closePopovers: () => {},
    teleport: teleportable ? (x, z, h) => calls.push(['teleport', x, z, h]) : null
  });
  return { ui, calls, navigator, mapSystem, controllerManager, popover, pick, byId, places, fullCanvas };
}

const place = (h, name) => h.byId('nav-places').children.find((b) => b.children[0].textContent === name);
const way = (h, d) => h.popover.querySelector(`[data-driver="${d}"]`);
const pickWay = (h, g) => h.pick.querySelector(`[data-go="${g}"]`);

test('the Navigate menu lists the places and goes there the way it is set to', () => {
  const h = harness();
  assert.equal(h.byId('nav-places').children.length, 2);
  place(h, 'Raffles Place').click();
  assert.deepEqual(h.calls, [['destination', 10, 20, 'Raffles Place']], 'navigates (you drive) by default');
  h.calls.length = 0;
  way(h, 'self').click();
  assert.deepEqual(h.calls, [['mode', 'car'], ['driver', 'self']], 'self-driving puts you in the car');
  place(h, 'Merlion Park').click();
  assert.deepEqual(h.calls.slice(-1), [['destination', -30, 40, 'Merlion Park']]);
});

test('Teleport is one of the ways to go: the places teleport to their arrival points', () => {
  const h = harness();
  way(h, 'teleport').click();
  assert.equal(h.ui.how, 'teleport');
  assert.ok(way(h, 'teleport').classList.contains('active'), 'shown as the chosen way');
  assert.equal(h.calls.length, 0, 'choosing it changes no driver');
  place(h, 'Merlion Park').click();
  assert.deepEqual(h.calls, [['teleport', -30, 40, 2]]);
  assert.equal(h.navigator.active, false, 'and starts no trip');
});

test('a tap on the map opens a menu there; each item goes that way', () => {
  for (const [g, expected] of [
    ['you', [['map', false], ['destination', 5, 6, 'Somewhere']]],
    ['self', [['map', false], ['mode', 'car'], ['driver', 'self'], ['destination', 5, 6, 'Somewhere']]],
    ['crazy', [['map', false], ['mode', 'car'], ['driver', 'crazy'], ['destination', 5, 6, 'Somewhere']]],
    ['teleport', [['teleport', 5, 6, undefined]]]
  ]) {
    const h = harness();
    assert.equal(typeof h.mapSystem.onPick, 'function', 'the UI takes the map\'s taps');
    h.mapSystem.onPick(5, 6, 'Somewhere', 400, 300);
    assert.equal(h.pick.hidden, false, 'menu shown');
    assert.equal(h.byId('map-pick-title').textContent, 'Somewhere');
    assert.equal(h.pick.style.left, '412px');
    pickWay(h, g).click();
    assert.equal(h.pick.hidden, true, `${g}: menu put away`);
    assert.deepEqual(h.calls, expected, g);
  }
});

test('the tap menu stays on screen, goes away on a drag, and hides Teleport when there is none', () => {
  const h = harness({ teleportable: false });
  h.mapSystem.onPick(1, 2, 'Edge', 990, 690);
  assert.equal(h.pick.style.left, `${1000 - 220 - 8}px`);
  assert.equal(h.pick.style.top, `${700 - 200 - 8}px`);
  assert.equal(pickWay(h, 'teleport').hidden, true);
  h.fullCanvas.dispatch('pointerdown');
  assert.equal(h.pick.hidden, true);
  // and closing the map
  h.mapSystem.onPick(1, 2, 'Edge', 10, 10);
  h.mapSystem.toggleFullMap(false);
  assert.equal(h.pick.hidden, true);
});

test('a trip on the go carries on after a teleport, from the new spot', () => {
  const h = harness();
  place(h, 'Raffles Place').click();
  way(h, 'teleport').click();
  h.calls.length = 0;
  place(h, 'Merlion Park').click();
  assert.deepEqual(h.calls, [['teleport', -30, 40, 2], ['reroute']]);
});
