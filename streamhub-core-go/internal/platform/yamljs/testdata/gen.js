// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Golden vectors for package yamljs, produced by the js-yaml copy the Node
// core ships. Regenerate from the repo root with:
//
//   cd streamhub-core && node ../streamhub-core-go/internal/platform/yamljs/testdata/gen.js
//
// Three vector kinds (all dumps use { lineWidth: 120 }):
//   <name>.input.json              plain JSON object        → <name>.yaml = dump(JSON.parse(input))
//   <name>.value.json              tagged JS value (below)  → <name>.yaml = dump(value)
//   <name>.src.yaml                YAML source              → <name>.json = tagged load(src)
//                                                             <name>.yaml = dump(load(src))
//                                                             (no .yaml when js-yaml emits &ref_ anchors;
//                                                              .json is {"$error": msg} when load throws)
//
// Tagged JSON: numbers {"$num": String(n) or "-0"}, Dates {"$date": iso},
// undefined {"$undefined": true}, objects {"$obj": [[key, value], ...]} in
// Object.keys order, arrays as JSON arrays, everything else as itself.
'use strict'

process.env.TZ = 'UTC' // String(Date) keys depend on the process TZ

const fs = require('fs')
const path = require('path')
// Resolve js-yaml from the cwd (streamhub-core), not from this file's directory.
const yaml = require(require.resolve('js-yaml', { paths: [process.cwd()] }))

const OUT = __dirname
const DUMP = { lineWidth: 120 }

function tag (v) {
  if (v === undefined) return { $undefined: true }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return { $num: Object.is(v, -0) ? '-0' : String(v) }
  if (v instanceof Date) return { $date: v.toISOString() }
  if (Array.isArray(v)) return v.map(tag)
  return { $obj: Object.keys(v).map((k) => [k, tag(v[k])]) }
}

function write (name, content) {
  fs.writeFileSync(path.join(OUT, name), content)
}

// ---- JSON inputs ----------------------------------------------------------------

const quoteStrings = [
  'true', 'false', 'True', 'TRUE', '123', '-5', '+12', '1.5', '.5', '1e3', '0x1F', '0o17', '0b101', '012',
  '1_000', '.inf', '-.Inf', '.nan', '2020-01-01', '2020-01-01T10:00:00Z', '2020-1-1 1:02:03', '~', 'null',
  'Null', 'NULL', '', 'yes', 'no', 'on', 'off', 'y', 'N', 'On', 'OFF', '1:20', '-1:20:30.5', '<<',
  ' lead', 'trail ', ' both ', '-', '-x', '- x', '?', '?x', ':', ':x', '#x', '&x', '*x', '!x', '|x', '>x',
  "'x", '"x', '%x', '@x', '`x', '=x', ',x', '[x', ']x', '{x', '}x', 'x,y', 'x[y]', 'x{y}',
  'a: b', 'a:b', 'a:', 'a #b', 'a#b', 'a #', "it's", 'say "hi"', 'http://x:1/y', '${app}_${room}',
  'rtmp://live.example.com/app/key?x=1&y=2', 'C:\\path\\file', 'plain text', 'x\ty', 'tab\t', 'ünïcödé',
  '日本語', 'emoji 🎥 cam', '🎥', 'a\u2028b', 'nbsp\u00a0x', 'bom\ufeffx', 'ctl\u0001x', 'del\u007fx',
  'nel\u0085x', 'esc\u001bx', 'nul\u0000x', 'bell\u0007', 'bs\\x', 'cr\rx', 'lsep\u2029x'
]

function quotingObject () {
  const o = {}
  quoteStrings.forEach((s, i) => { o['v' + i] = s })
  return o
}

function keysObject () {
  const o = {}
  quoteStrings.forEach((s, i) => { if (s !== '') o[s] = i })
  o[''] = 'empty key'
  return o
}

const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et ' +
  'dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea.'

const jsonCases = {
  app_config: {
    name: 'demo-app',
    display_name: 'Demo App',
    room_prefix: 'demo_',
    enabled: true,
    max_streams: 50,
    bitrate_kbps: 2500.5,
    description: '',
    s3: { bucket: 'streamhub-demo', region: 'us-east-1', prefix: '', path_style: false, secret_ref: 's3:demo' },
    recording: { enabled: false, format: 'mp4', layers: [] },
    hls: { enabled: true, segment_seconds: 2, playlist_size: 6, low_latency: false },
    transcoding: {
      enabled: true,
      layers: [
        { name: '1080p', width: 1920, height: 1080, bitrate: 4500000, fps: 30 },
        { name: '720p', width: 1280, height: 720, bitrate: 2500000, fps: 30 },
        { name: '360p', width: 640, height: 360, bitrate: 800000, fps: 15.5 }
      ]
    },
    webhooks: [
      { url: 'https://hooks.example.com/streamhub?token=abc&x=1', events: ['all'], secret: 'whsec_123', retries: 3 },
      { url: 'http://10.0.0.5:8080/cb', events: ['stream.started', 'stream.ended'], headers: {} }
    ],
    features: { cockpit: { enabled: true, layout: 'grid' }, lpr: {}, deface: { enabled: false, threshold: 0.35 } },
    security: { ip_allow: [], ip_block: ['10.0.0.0/8', '192.168.1.1'], play_token_ttl: 3600 },
    callback_url: null,
    tags: ['prod', 'live', '2024'],
    meta: {}
  },
  quoting_values: quotingObject(),
  quoting_list: quoteStrings,
  quoting_keys: keysObject(),
  multiline: {
    lit: 'line one\nline two\n',
    lit_nonl: 'line one\nline two',
    lit_keep: 'a\nb\n\n',
    lit_keep3: 'a\n\n\n',
    only_nl: '\n',
    two_nl: '\n\n',
    lead_nl: '\nfoo',
    lead_space: '  indented\nnext\n',
    lead_nl_space: '\n  x\ny',
    trailing_space_line: 'a \nb',
    with_tab: 'a\tb\nc',
    blank_lines: 'p1\n\np2\n\n\np3\n',
    crlf: 'a\r\nb\r\n',
    nested: { deeper: { text: '#!/bin/sh\necho "hi: there"\nexit 0\n' } },
    in_list: ['first\nsecond', 'x\ny\n']
  },
  long_lines: {
    long: lorem,
    nested: { a: { b: { c: { d: { e: { f: { g: { h: { i: { j: { k: { l: { m: { n: { o: { p: { q: { r: { s: { t: lorem } } } } } } } } } } } } } } } } } } } },
    long_nospace: 'x'.repeat(200),
    long_multispace: 'word  '.repeat(30) + 'end',
    long_lead_space: ' ' + lorem,
    long_multi: lorem + '\n' + lorem + '\n\n  more-indented ' + lorem + '\n' + lorem,
    long_trailing_nl: lorem + '\n',
    edge_121: 'a '.repeat(60) + 'b',
    edge_118: 'x'.repeat(59) + ' ' + 'y'.repeat(58),
    in_list: [lorem, [lorem]],
    long_emoji: '🎥 '.repeat(70) + 'end',
    long_cjk: '日本語のテキスト '.repeat(20),
    long_colon: 'key: value '.repeat(15)
  },
  unicode: { emoji: '😀🎉', mixed: 'a😀b', astral_math: '𝔘𝔫𝔦', u2028: 'x\u2028y', u2029: '\u2029', rtl: 'שלום', combining: 'e\u0301', fffd: '\ufffd', 'ключ': 'значение', '🔑': 'v' },
  int_keys: { b: 1, 10: 'ten', a: 2, 2: 'two', '01': 'lead zero', 0: 'zero', '-1': 'neg', 4294967294: 'max idx', 4294967295: 'not idx', '1.5': 'float' },
  nested_arrays: { m: [[1, 2], [[3, [4]], []], [], [{}], [{ a: 1, b: [5] }]], top: [[['deep']]] },
  numbers: {
    zero: 0, negzero: -0, one: 1, neg: -5, big: 123456789012, max_safe: 9007199254740991, beyond: 9007199254740993,
    e21: 1e21, e20: 1e20, small: 1.5e-7, tiny: 1e-7, micro: 0.000001, tenth: 0.1, third: 1 / 3, pi: 3.141592653589793,
    neg_small: -2.5e-10, huge: 1.7976931348623157e308, denorm: 5e-324, f: 100.25, e5: 5e-100, ex: 1.23e45
  },
  nulls_empty: { n: null, e: {}, a: [], s: '', list: [null, '', {}, []], nested: { x: null } }
}

// ---- tagged JS values (not expressible in JSON) ---------------------------------

// Seeded pseudo-random vectors (mulberry32) to stress chooseScalarStyle,
// foldString/foldLine and number formatting with deterministic inputs.
function mulberry32 (a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0
    let t = Math.imul(a ^ a >>> 15, 1 | a)
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t
    return ((t ^ t >>> 14) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20261027)
const ALPHABET = ['a', 'b', 'Z', '0', '1', '9', ' ', ' ', ' ', '  ', '\n', '\n\n', ':', '#', '-', '?', "'", '"', '.', 'e',
  '\t', ',', '[', '{', '&', '*', '!', '|', '>', '%', '@', '`', '🎥', 'é', '日', '\u2028', '\u0085', '\u00a0', '\\', 'true',
  'null', '~', 'word ', 'lorem ipsum ', 'x'.repeat(30)]
function rndString () {
  const n = Math.floor(rnd() * (rnd() < 0.3 ? 80 : 12))
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]
  return s
}
function nest (v, depth) { return depth === 0 ? v : { k: nest(v, depth - 1) } }
function fuzzStrings () {
  const o = {}
  for (let i = 0; i < 400; i++) o['s' + i] = nest(rndString(), i % 6)
  for (let i = 0; i < 100; i++) o[rndString().replace(/\n/g, ' ') || 'empty' + i] = i
  o.list = Array.from({ length: 60 }, () => (rnd() < 0.5 ? rndString() : [rndString(), { x: rndString() }]))
  return o
}
// Printable-only, long strings: exercises literal/folded block styles.
const FOLD_ALPHABET = ['word', 'lorem', 'é', '🎥', '日本', ' ', ' ', ' ', ' ', '  ', '\n', '\n', '\n\n', ': ', '#', '-',
  "'", 'x'.repeat(50), ' indented', '\n  more']
function fuzzFolding () {
  const o = {}
  for (let i = 0; i < 300; i++) {
    const n = Math.floor(rnd() * 160)
    let str = ''
    for (let j = 0; j < n; j++) str += FOLD_ALPHABET[Math.floor(rnd() * FOLD_ALPHABET.length)]
    o['f' + i] = nest(i % 7 === 0 ? [str] : str, i % 9)
  }
  return o
}
function fuzzNumbers () {
  const buf = new DataView(new ArrayBuffer(8))
  const out = []
  for (let i = 0; i < 300; i++) {
    buf.setUint32(0, Math.floor(rnd() * 4294967296)); buf.setUint32(4, Math.floor(rnd() * 4294967296))
    out.push(buf.getFloat64(0))
  }
  for (let i = 0; i < 100; i++) out.push(Math.floor(rnd() * 1e6) / Math.pow(10, Math.floor(rnd() * 12)))
  for (let i = 0; i < 50; i++) out.push(Math.round((rnd() - 0.5) * Math.pow(2, Math.floor(rnd() * 70))))
  return out
}

const valueCases = {
  fuzz_strings: fuzzStrings(),
  fuzz_numbers: fuzzNumbers(),
  fuzz_folding: fuzzFolding(),
  special_numbers: { nan: NaN, inf: Infinity, ninf: -Infinity, negzero: -0, list: [NaN, -0, -Infinity] },
  undefined_values: { a: 1, u: undefined, b: [1, undefined, 'x'], allu: { x: undefined }, onlyu: [undefined] },
  dates: { d: new Date(Date.UTC(2020, 0, 1)), t: new Date(Date.UTC(2021, 5, 15, 13, 45, 30, 123)), list: [new Date(0)] },
  top_array: ['a', { b: 1, c: [] }, [2, 3]],
  top_string: 'just a string',
  top_number: 42,
  top_null: null,
  top_empty_map: {},
  top_undefined: undefined
}

// ---- YAML sources -----------------------------------------------------------------

const srcCases = {
  load_numbers: [
    'oct: 0o17', 'hex: 0x1F', 'hex_lower: 0xff', 'bin: 0b101', 'plus: +12', 'minus: -12', 'neg_hex: -0x10',
    'dot5: .5', 'exp: 1e3', 'exp_neg: 1.5E-3', 'lead0: 012', 'zero: 0', 'negzero: -0', 'negzerof: -0.0',
    'under: 1_000', 'one_dot: 1.', 'big: 99999999999999999999', 'huge: 1e400', 'bighex: 0xFFFFFFFFFFFFFFFFFF',
    'inf: .inf', 'ninf: -.Inf', 'pinf: +.INF', 'nan: .NaN', 'neg_dot: -.5', 'bad_hex: 0x', 'bad_bin: 0b2',
    'sci: 6.02e+23', 'float: 3.14', 'intlike_float: 2.0', 'sixty: 1:20', 'oct_old: 0755', 'plus_zero: +0'
  ].join('\n') + '\n',
  load_bools: 'a: true\nb: True\nc: TRUE\nd: false\ne: yes\nf: no\ng: on\nh: off\ni: y\nj: N\nk: tRue\n',
  load_nulls: 'a: ~\nb: null\nc: Null\nd: NULL\ne:\nf: nUll\ng: ""\nh: \'\'\n',
  load_dates: [
    'date: 2020-01-01', 'dt: 2001-12-14t21:59:43.10-05:00', 'iso: 2001-12-14T21:59:43.123456Z',
    'space: 2001-12-14 21:59:43.10 -5', 'notz: 2001-12-14 2:59:43', 'plus: 2002-12-14T01:02:03+02:30',
    'overflow: 2020-02-30', 'month0: 2020-00-10', 'year50: 0050-01-01', 'shortdate: 2020-1-1',
    'frac_empty: 2020-01-01T00:00:00.Z'
  ].join('\n') + '\n',
  load_ordering: 'b: 1\n2: two\na: 3\n1: one\n10: ten\n"01": zero-one\n-1: neg\n',
  load_keys: [
    '1: int', 'true: bool', '~: null', '1.5: float', '0x10: hex', '[a, b]: seq', '{a: 1}: map', '.nan: nan',
    '-0: negzero', '2020-01-01: date-key-as-string', '"quoted": q', "'single': s", '? complex\n: explicit',
    '[1, [x]]: ignored'
  ].slice(0, 13).join('\n') + '\n',
  load_merge: [
    'base: &base', '  a: 1', '  b: 2', 'other: &other', '  b: 20', '  c: 30',
    'merged:', '  <<: *base', '  b: 99', 'multi:', '  <<: [*base, *other]', '  d: 4',
    'over:', '  x: 0', '  <<: *base', 'flow: {<<: *other, c: 3}', 'quoted_merge:', '  "<<": literal'
  ].join('\n') + '\n',
  load_merge_override: 'base: &b {a: 1, b: 2}\nm:\n  <<: *b\n  a: 10\n',
  load_anchors_scalar: 'x: &v hello\ny: *v\nn: &n 42\nm: *n\nlist: [*v, *n]\n',
  load_anchors_object: 'tpl: &t {a: 1, list: [1, 2]}\nuse1: *t\nuse2: *t\n',
  load_strings: [
    'plain: hello world', 'sq: \'it\'\'s\'', 'dq: "tab\\there\\u00e9\\x41\\U0001F600"', 'folded: >\n  a\n  b\n\n  c',
    'literal: |\n  x\n  y', 'strip: |-\n  x', 'keep: |+\n  x\n\n', 'indicator: |2\n    lead\n  x', 'multi: a\n  b\n  c',
    'colon_in: a:b', 'hash_in: a#b', 'url: http://x:1/y', 'tpl: ${app}_${room}', 'emoji: 🎥', 'unicode_esc: "\\u2028"'
  ].join('\n') + '\n',
  load_explicit_tags: [
    'a: !!str 12', 'b: !!int "12"', 'c: !!float 1', 'd: !!bool "true"', 'e: !!null ""', 'f: !!str',
    'g: !!timestamp 2020-01-01', 'h: !!map {x: 1}', 'i: !!seq [1]', 'j: !!null', 'k: !!map', 'l: !!str true'
  ].filter((l) => !l.startsWith('e:')).join('\n') + '\n',
  load_flow: 'a: [1, two, {three: 3}, [4]]\nb: {x: y, z}\nc: []\nd: {}\n',
  load_top_seq: '- a\n- 1\n- - nested\n  - 2\n- k: v\n  k2: v2\n',
  load_top_scalar: 'just text\n',
  load_top_number: '0x10\n',
  load_empty: '',
  load_comment_only: '# nothing here\n\n# still nothing\n',
  load_doc_marker_empty: '---\n',
  load_doc_marker: '--- \na: 1\n...\n',
  load_comments: 'a: 1 # trailing\n# full\nb: "x # not comment"\n',
  load_realistic: [
    '# StreamHub app config',
    'name: demo',
    'enabled: true',
    'max_streams: 50',
    'webhooks:',
    '  - url: https://hooks.example.com/x?y=1',
    '    events: [all]',
    '    secret: ""',
    '  - url: http://10.0.0.1:8080',
    '    events:',
    '      - stream.started',
    'transcoding:',
    '  layers:',
    '  - {name: 720p, width: 1280, bitrate: 2.5e6}',
    'features: {}',
    'tags: []',
    'created: 2024-03-01T12:00:00Z'
  ].join('\n') + '\n',
  err_duplicate: 'a: 1\nb: 2\na: 3\n',
  err_duplicate_normalized: '1: a\n01: b\n',
  err_duplicate_after_merge: 'base: &b {a: 1}\nm:\n  <<: *b\n  a: 2\n  a: 3\n',
  err_multidoc: 'a: 1\n---\nb: 2\n',
  err_multidoc_empty: 'a: 1\n---\n',
  err_unknown_tag: 'a: !foo bar\n',
  err_unknown_tag_global: 'a: !!python/str x\n',
  err_bad_int_tag: 'a: !!int abc\n',
  err_merge_scalar: 'a:\n  <<: 1\n',
  err_syntax: 'a: [1, 2\n',
  err_nested_array_key: '? [1, [2]]\n: x\n'
}

// ---- write -------------------------------------------------------------------------

for (const f of fs.readdirSync(OUT)) {
  if (/\.(json|yaml)$/.test(f)) fs.unlinkSync(path.join(OUT, f))
}

for (const [name, obj] of Object.entries(jsonCases)) {
  write(name + '.input.json', JSON.stringify(obj, null, 2) + '\n')
  write(name + '.yaml', yaml.dump(JSON.parse(JSON.stringify(obj)), DUMP))
}

for (const [name, v] of Object.entries(valueCases)) {
  write(name + '.value.json', JSON.stringify(tag(v), null, 2) + '\n')
  write(name + '.yaml', yaml.dump(v, DUMP))
}

for (const [name, src] of Object.entries(srcCases)) {
  write(name + '.src.yaml', src)
  let v
  try {
    v = yaml.load(src)
  } catch (e) {
    write(name + '.json', JSON.stringify({ $error: e.reason || e.message }) + '\n')
    continue
  }
  write(name + '.json', JSON.stringify(tag(v), null, 2) + '\n')
  const out = yaml.dump(v, DUMP)
  if (!/&ref_/.test(out)) write(name + '.yaml', out)
}

console.log('vectors:', Object.keys(jsonCases).length, Object.keys(valueCases).length, Object.keys(srcCases).length)
