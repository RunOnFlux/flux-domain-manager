# Flux Domain Manager

![Flux.png](ZelFront/src/assets/img/flux_banner.png)

Flux Domain Manager (FDM) processes requests from Flux network and adjusts corresponding domain for nodes on the Flux network. Domain has to be manageable on cloudflare. FDM takes an API key as parameter.

FDM has to live on registrar.YOURROOT.DOMAIN

Flux nodes then do requests to registrar to register specific A record for porivded IPv4 address.

Suppose an application of named DiBiFetch registered by owner of zelID X. As registration parameter, domain can be set as well as controlling registrar. Let's suppose application owner decided to input domain app.dibifetch.com as a domain on which dibifetch shall run

- main domain app.dibifetch.com will be registered for our FDM server
- subdomains 1.app.dibifetch.com, 2.app.dibifetch.com etc. will be registered on Flux nodes where the application currently runs. In case application is no longer running there, domain record will be removed
- load balancing will be set on FDM to point to Flux nodes running the application
- Flux nodes running the application obtain their ssl certificates, adjusts their haproxy configuration and are now part of the app.dibifetch.com

Furthermore central FDM authority managed by Flux team exists and does domain, ssl management for all application on Flux network. In case of DiBiFetch application, an application will also live on APPNAME.runonflux.com, in this case FDM manages dibifetch.runonflux.com.

Every Flux node is also part of RunOnFlux domain under this central FDM. Every node is part of ui.runonflux.com and api.runonflux.com with all Flux domains having X.ui.runonflux.com and X.api.runonflux.com being loadbalanced.

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
nano /etc/haproxy/haproxy.cfg
sudo service haproxy reload
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