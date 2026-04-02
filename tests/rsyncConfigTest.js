/* eslint-disable func-names */
const chai = require('chai');
const ini = require('ini');
const fs = require('fs');
const path = require('path');

const { expect } = chai;

// Parse the actual hosts.ini to test against real data
const hostsIniPath = path.resolve(__dirname, '../deployment/hosts.ini');
const hosts = ini.parse(fs.readFileSync(hostsIniPath, 'utf-8'));

// Import the module (uses default rsync_config.json: fdm_fn1_app / app_fdm_servers)
const { getGroupPeerIPs, getGroupIPs, getPrimaryIP, parseHostConfig } = require('../src/services/rsync/config');

describe('rsync config', function () {
  describe('getGroupPeerIPs', () => {
    it('returns an array of IPs', () => {
      const result = getGroupPeerIPs();
      expect(result).to.be.an('array');
    });

    it('does not include the current host', () => {
      // Default rsync_config.json has host=fdm_fn1_app, which has rsyncIP=5.39.57.42
      const result = getGroupPeerIPs();
      expect(result).to.not.include('5.39.57.42');
    });

    it('only returns peers from the same group number', () => {
      // fdm_fn1_app is group 1 — peers should be fdm_sg1_app and fdm_us1_app
      const result = getGroupPeerIPs();
      expect(result).to.include('146.190.83.190'); // fdm_sg1_app
      expect(result).to.include('5.161.211.14'); // fdm_us1_app
      expect(result).to.have.lengthOf(2);
    });
  });

  describe('getGroupIPs', () => {
    it('returns all IPs in the group including self', () => {
      const result = getGroupIPs();
      expect(result).to.be.an('array');
      expect(result).to.include('5.39.57.42'); // fdm_fn1_app (self)
      expect(result).to.include('146.190.83.190'); // fdm_sg1_app
      expect(result).to.include('5.161.211.14'); // fdm_us1_app
      expect(result).to.have.lengthOf(3);
    });

    it('does not include hosts from other groups', () => {
      const result = getGroupIPs();
      expect(result).to.not.include('5.39.57.43'); // fdm_fn2_app (group 2)
      expect(result).to.not.include('5.39.57.44'); // fdm_fn3_app (group 3)
    });
  });

  describe('getPrimaryIP', () => {
    it('returns the EU (fn) host IP for the current group', () => {
      // Default config is fdm_fn1_app which IS the fn host, so it returns its own IP
      const result = getPrimaryIP();
      expect(result).to.equal('5.39.57.42');
    });

    it('returns a string IP address', () => {
      const result = getPrimaryIP();
      expect(result).to.be.a('string');
      expect(result).to.match(/^\d+\.\d+\.\d+\.\d+$/);
    });
  });

  describe('parseHostConfig', () => {
    it('parses a standard host config line', () => {
      const input = 'ansible_host=10.100.0.157 ansible_user=root fdmAppDomain=fdm-fn-1-1.runonflux.io startSubset=0 endSubset=G rsyncIP=5.39.57.42';
      const result = parseHostConfig(input);
      expect(result).to.deep.equal({
        ansible_host: '10.100.0.157',
        ansible_user: 'root',
        fdmAppDomain: 'fdm-fn-1-1.runonflux.io',
        startSubset: '0',
        endSubset: 'G',
        rsyncIP: '5.39.57.42',
      });
    });

    it('handles config without rsyncIP', () => {
      const input = 'ansible_host=128.199.246.121 ansible_user=root';
      const result = parseHostConfig(input);
      expect(result).to.deep.equal({
        ansible_host: '128.199.246.121',
        ansible_user: 'root',
      });
      expect(result.rsyncIP).to.be.undefined;
    });

    it('returns empty object for empty string', () => {
      const result = parseHostConfig('');
      expect(result).to.deep.equal({});
    });
  });

  describe('certRenewalPrimary derivation', () => {
    it('every host in app_fdm_servers is correctly classified as primary or not', () => {
      const appHosts = Object.keys(hosts.app_fdm_servers);
      appHosts.forEach((hostKey) => {
        const isPrimary = hostKey.includes('_fn');
        if (isPrimary) {
          expect(hostKey, `${hostKey} should be EU primary`).to.match(/_fn\d_/);
        } else {
          expect(hostKey, `${hostKey} should not be EU primary`).to.not.include('_fn');
        }
      });
    });

    it('every host in app2_fdm_servers is correctly classified as primary or not', () => {
      const appHosts = Object.keys(hosts.app2_fdm_servers);
      appHosts.forEach((hostKey) => {
        const isPrimary = hostKey.includes('_fn');
        if (isPrimary) {
          expect(hostKey, `${hostKey} should be EU primary`).to.match(/_fn\d_/);
        } else {
          expect(hostKey, `${hostKey} should not be EU primary`).to.not.include('_fn');
        }
      });
    });

    it('each group has exactly one primary', () => {
      const appHosts = Object.keys(hosts.app_fdm_servers);
      const groupNumbers = [...new Set(appHosts.map((h) => h.charAt(6)))];
      groupNumbers.forEach((num) => {
        const primaries = appHosts.filter((h) => h.charAt(6) === num && h.includes('_fn'));
        expect(primaries, `Group ${num} should have exactly 1 primary`).to.have.lengthOf(1);
      });
    });
  });

  describe('hosts.ini structure', () => {
    it('has app_fdm_servers section', () => {
      expect(hosts).to.have.property('app_fdm_servers');
    });

    it('has app2_fdm_servers section', () => {
      expect(hosts).to.have.property('app2_fdm_servers');
    });

    it('every app_fdm_servers group has an fn (EU) host', () => {
      const appHosts = Object.keys(hosts.app_fdm_servers);
      const groupNumbers = [...new Set(appHosts.map((h) => h.charAt(6)))];
      groupNumbers.forEach((num) => {
        const fnHost = appHosts.find((h) => h.charAt(6) === num && h.includes('_fn'));
        expect(fnHost, `Group ${num} should have an fn host`).to.not.be.undefined;
      });
    });

    it('every app2_fdm_servers group has an fn (EU) host', () => {
      const app2Hosts = Object.keys(hosts.app2_fdm_servers);
      const groupNumbers = [...new Set(app2Hosts.map((h) => h.charAt(6)))];
      groupNumbers.forEach((num) => {
        const fnHost = app2Hosts.find((h) => h.charAt(6) === num && h.includes('_fn'));
        expect(fnHost, `Group ${num} should have an fn host`).to.not.be.undefined;
      });
    });
  });
});
