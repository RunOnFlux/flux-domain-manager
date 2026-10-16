'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Ansible renders deployment/default.js.j2 over config/default.js on every director, so
// the template IS the production config — a key present here but missing there is
// undefined on the whole fleet at once, on the next deploy. That has now happened twice
// (customConfigs/haproxyRouting/cryptoService/domainOverrides, then
// sharedDbRouting/appChecks/staticLocations), so it is pinned rather than remembered.
const CONFIG_DIR = path.join(__dirname, '..', '..', 'config');
const TEMPLATE = path.join(__dirname, '..', '..', 'deployment', 'default.js.j2');

// Render the template with every Jinja expression collapsed to one placeholder
// identifier. `{{ x }}` and `'{{ x }}'` both become valid JS that way, so the result
// requires like any other config module. Relative requires are pinned at config/ because
// the rendered file lives elsewhere.
function requireRenderedTemplate() {
  const rendered = `const jinja = 'placeholder';\n${
    fs.readFileSync(TEMPLATE, 'utf8')
      .replace(/\{\{[^}]*\}\}/g, 'jinja')
      .replace(/require\('\.\/([^']+)'\)/g, `require('${CONFIG_DIR}/$1')`)}`;
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fdm-template-')), 'rendered.js');
  fs.writeFileSync(file, rendered);
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(file);
  } finally {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
}

// Values legitimately differ per director; the key structure must not.
function shape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, shape(value[key])]),
  );
}

describe('deployment/default.js.j2', () => {
  it('offers every key config/default.js does', () => {
    // eslint-disable-next-line global-require
    const committed = require('../../config/default');
    expect(shape(requireRenderedTemplate())).to.deep.equal(shape(committed));
  });
});

// Each playbook checks, per FDM checkout it sets up, that every config file the config
// requires is present. A file missing from that list is never checked.
describe('deployment playbooks', () => {
  const required = fs.readFileSync(path.join(CONFIG_DIR, 'default.js'), 'utf8')
    .match(/require\('\.\/[^']+'\)/g)
    .map((r) => r.slice("require('./".length, -"')".length))
    .map((name) => fs.readdirSync(CONFIG_DIR).find((f) => f.replace(/\.(js|json)$/, '') === name));

  ['fdm_setup.yml', 'fdm_main_setup.yml', 'fdm_main_dev_setup.yml'].forEach((playbook) => {
    it(`${playbook} checks every config file config/default.js requires`, () => {
      const text = fs.readFileSync(path.join(__dirname, '..', '..', 'deployment', playbook), 'utf8');
      const checks = text.split('- name: Ensure config files exist').slice(1)
        .map((task) => task.split('\n    - name:')[0]);
      expect(checks.length).to.be.above(0);
      checks.forEach((task) => {
        required.forEach((file) => expect(task, `${playbook} does not check ${file}`).to.contain(`- ${file}\n`));
      });
    });
  });
});
