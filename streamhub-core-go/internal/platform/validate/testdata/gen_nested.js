// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates nested_vectors.json: the exact message list Nest's
// ValidationPipe({transform, whitelist}) returns for @ValidateNested
// properties (objects, arrays with/without {each:true}, primitive elements,
// arrays of arrays) and how child errors REPLACE the property's own
// constraints. Run from the repo root:
//   node streamhub-core-go/internal/platform/validate/testdata/gen_nested.js
const path = require('node:path');
const fs = require('node:fs');
const core = path.resolve(__dirname, '../../../../../streamhub-core/node_modules');
require(path.join(core, 'reflect-metadata'));
const cv = require(path.join(core, 'class-validator'));
const { Type } = require(path.join(core, 'class-transformer'));
const { ValidationPipe } = require(path.join(core, '@nestjs/common'));

// decorators as written top-down in a TS class (applied bottom-up)
function deco(cls, prop, ...ds) {
  for (const d of ds.reverse()) d(cls.prototype, prop);
}
class Child {}
deco(Child, 'name', cv.IsString(), cv.MaxLength(3));
deco(Child, 'n', cv.IsInt(), cv.Min(1));
class Parent {}
deco(Parent, 'items', cv.IsOptional(), cv.IsArray(), cv.ArrayMaxSize(2), cv.ValidateNested({ each: true }), Type(() => Child));
deco(Parent, 'obj', cv.IsOptional(), cv.ValidateNested(), Type(() => Child));
deco(Parent, 'plain', cv.IsOptional(), cv.ValidateNested(), Type(() => Child));
deco(Parent, 'flag', cv.IsOptional(), cv.IsBoolean());

const bodies = [
  {},
  { items: [{ name: 'abcd', n: 0 }, 5, { name: 'ok', n: 2 }] },
  { items: 'x' },
  { items: 7, obj: 'y', plain: 3, flag: 'z' },
  { items: [{ name: 'a', n: 1 }, { name: 'b', n: 1 }, { name: 'c', n: 1 }] },
  { items: [[1, { name: 5 }], 'q'] },
  { items: { name: 7 } },
  { items: { name: 'a', n: 1 } },
  { items: [] },
  { obj: { name: 'long', n: 1.5 } },
  { obj: [{ name: 1 }, 2] },
  { plain: [3, [4]] },
  { obj: null, items: null },
  { flag: 1, obj: {} },
];

(async () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const out = [];
  for (const body of bodies) {
    let messages = [];
    try {
      await pipe.transform(body, { type: 'body', metatype: Parent });
    } catch (e) {
      messages = e.getResponse().message;
    }
    out.push({ body, messages });
  }
  fs.writeFileSync(path.join(__dirname, 'nested_vectors.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out, null, 0));
})();
