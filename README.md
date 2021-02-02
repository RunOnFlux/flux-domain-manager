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
