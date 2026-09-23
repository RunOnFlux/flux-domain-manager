/* eslint-disable func-names */
const chai = require('chai');
const fs = require('fs');
const path = require('path');

const { expect } = chai;

const SRC = path.join(__dirname, '..', 'src');

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function withoutComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// A property call on a required module is not checked by lint, so a function
// removed from a shared module fails only when its caller runs. For every
// `const x = require('<a src module>')`, every `x.<member>` in that file must be
// something the module exports.
describe('references to required src modules', () => {
  it('every member used through a module binding exists on that module', () => {
    const missing = [];
    sourceFiles(SRC).forEach((file) => {
      const text = withoutComments(fs.readFileSync(file, 'utf8'));
      const bindings = Array.from(
        text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(['"](\.{1,2}\/[^'"]+)['"]\)/g),
        (m) => ({ name: m[1], target: require.resolve(path.resolve(path.dirname(file), m[2])) }),
      );
      bindings.forEach(({ name, target }) => {
        // eslint-disable-next-line global-require, import/no-dynamic-require
        const exported = require(target);
        const pattern = new RegExp(`(?<![\\w$.])${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
        Array.from(text.matchAll(pattern), (m) => m[1]).forEach((member) => {
          if (!(member in exported)) missing.push(`${path.relative(SRC, file)}: ${name}.${member}`);
        });
      });
    });
    expect(missing).to.deep.equal([]);
  });
});
