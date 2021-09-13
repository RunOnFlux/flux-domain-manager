# Flux Domain Manager

![Flux.png](https://raw.githubusercontent.com/RunOnFlux/flux/master/flux_banner.png)

Flux Domain Manager (FDM) manages domains, certificates and load balancing for entire Flux network as well as for applications running on Flux network. FDM in its basics is HAProxy configurator connected to Flux network.

Flux Team is running FDM on runonflux.io domain and is automatically managed on cloudflare. Anyone can stand up its own FDM on any domain with default settings providing own cloudflare API keys.

FDM scans Flux network, every healthy node on Flux network is put into FDM for both HOME.yourroot.domain (providing UI) and API.yourroot.domain (providing API endpoints to entire Flux).

Furthermore FDM load balances all applications running on Flux network putting them begind YOURAPPNAME.app.yourroot.domain. If an application has more ports, applications lives on [a,b,c,d,e...].YOURAPPNAME.app.yourroot.domain in order of how ports were registered on Flux application specifications.

- provide domain
- provide ssl
- load balancing
- Frontend (UI) for Flux network
- API for Flux network
- custom domains
- health checks of applications
- fully automated

## Application Overview

Install FDM dependancies (Ubuntu/CentOS/Redhat):

```bash
cd Flux

npm install
```

To run this as Production:

```bash
npm start
```

Application will run on port 16130


## FULL guide for ubuntu 20.04

```
sudo apt update
apt-get install software-properties-common certbot haproxy curl git wget screen -y
wget -qO- https://raw.githubusercontent.com/nvm-sh/nvm/v0.38.0/install.sh | bash
export NVM_DIR="$([ -z "${XDG_CONFIG_HOME-}" ] && printf %s "${HOME}/.nvm" || printf %s "${XDG_CONFIG_HOME}/nvm")"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh" # This loads nvm
nvm install 14
nvm use 14
wget -qO - https://www.mongodb.org/static/pgp/server-4.4.asc | sudo apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu focal/mongodb-org/4.4 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-4.4.list
sudo apt-get update
sudo apt-get install -y mongodb-org
sudo systemctl start mongod
sudo systemctl daemon-reload
sudo systemctl enable mongod
```
```
nano /etc/haproxy/haproxy.cfg
```

Paste this under all:
```
frontend wwwhttp
        bind 0.0.0.0:80
        option forwardfor except 127.0.0.0/8
        reqadd X-Forwarded-Proto:\ http

        acl letsencrypt-acl path_beg /.well-known/acme-challenge/
        use_backend letsencrypt-backend if letsencrypt-acl
        default_backend letsencrypt-backend

backend letsencrypt-backend
        server letsencrypt 127.0.0.1:8787
```

```
sudo service haproxy reload
sudo mkdir -p /etc/ssl/rosetta.runonflux.io
sudo certbot certonly --standalone -d rosetta.runonflux.io     --non-interactive --agree-tos --email tessjonesie@gmail.com     --http-01-port=8787
sudo cat /etc/letsencrypt/live/rosetta.runonflux.io/fullchain.pem     /etc/letsencrypt/live/rosetta.runonflux.io/privkey.pem     | sudo tee /etc/ssl/rosetta.runonflux.io/rosetta.runonflux.io.pem
```
```
sudo nano /opt/update-certs.sh
```
```
#!/usr/bin/env bash

# Renew the certificate
certbot renew --force-renewal --http-01-port=8787 --preferred-challenges http

# Concatenate new cert files, with less output (avoiding the use tee and its output to stdout)
bash -c "cat /etc/letsencrypt/live/rosetta.runonflux.io/fullchain.pem /etc/letsencrypt/live/rosetta.runonflux.io/privkey.pem > /etc/ssl/rosetta.runonflux.io/rosetta.runonflux.io.pem"

# Reload  HAProxy
service haproxy reload
```
```
sudo nano /etc/cron.d/certbot
```
```
0 0 1 * * root bash /opt/update-certs.sh
```
```
git clone https://github.com/runonflux/flux-domain-manager
cd flux-domain-manager/
npm i
screen -S FDM
npm start
```
