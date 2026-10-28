// HISTORICAL (since 3.2): this generator drives the retired NestJS core, which
// lives on only in branch legacy/node-2.x (tag 2.24.0) — run it from a checkout
// of that branch. Its output is a frozen cross-runtime vector: the Go code it
// locks is now the reference implementation.
//
// Generates length_vectors.json: class-validator @Length(min, max) (and the
// @IsOptional() variant) over missing / null / falsy / short / long / ok /
// non-string values, as the global ValidationPipe reports them.
//
//   cd streamhub-core && node ../streamhub-core-go/internal/platform/validate/testdata/gen_length.js \
//     > ../streamhub-core-go/internal/platform/validate/testdata/length_vectors.json
// resolve the deps from the cwd (streamhub-core), not from this file
const req = require('module').createRequire(process.cwd() + '/');
req('reflect-metadata');
const { Length, IsOptional, validateSync } = req('class-validator');
const { plainToInstance } = req('class-transformer');

const combos = [[1, 64], [3, 10], [0, 5]];
const values = [
  undefined, null, '', 'a', 'ab', 'abc', 'abcdefghij', 'abcdefghijk', 'x'.repeat(64), 'x'.repeat(65),
  0, 5, true, false, [], ['a'], ['a', 'b', 'c', 'd'], Array(12).fill('z'), {}, { length: 3 },
  '😀😀', '😀'.repeat(6), 'a️b', '😀'.repeat(65),
];
const out = [];
for (const [min, max] of combos) {
  for (const optional of [false, true]) {
    class Dto {}
    Length(min, max)(Dto.prototype, 'v');
    if (optional) IsOptional()(Dto.prototype, 'v');
    for (const v of values) {
      const body = v === undefined ? {} : { v };
      const errs = validateSync(plainToInstance(Dto, body));
      out.push({
        min, max, optional, body: JSON.stringify(body),
        messages: errs.flatMap((e) => Object.values(e.constraints || {})),
      });
    }
  }
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
