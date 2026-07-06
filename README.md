# mpi-15k-controller

Self-hosted controller for an MPI 15k hybrid solar inverter + home battery system:
automated spot-price buy/sell trading, state-of-charge tracking, temperature
monitoring, and a SolidStart web UI for live data and configuration.

## License

Copyright © 2024 Daniel Troger

This program is free software: you can redistribute it and/or modify it under the
terms of the **GNU Affero General Public License** as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later version
(`AGPL-3.0-or-later`).

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the [GNU Affero General Public License](./LICENSE) for more
details.

### Network use (AGPL §13)

This software is operated over a network (a WebSocket backend and a web frontend). If
you run a modified version and let others interact with it over a network, the AGPL
requires you to offer those users access to the **Corresponding Source** of your
modified version. The web UI carries a link to this repository for that purpose — if
you deploy a fork, point that link at your own source.

## Third-party components

This repository vendors third-party code that keeps its own license; those licenses
are unaffected by this project's AGPL license:

- `backend/vendor/@iiot2k/ads1115` — © Derya Y., **Apache-2.0** (see its bundled `LICENSE`).
- `backend/src/vendor/depictUtilishared.ts` — vendored from
  [depict-org/depict-ui](https://github.com/depict-org/depict-ui); retains its upstream license.

## Commercial licensing

The AGPL permits commercial use, but requires derivative and network-deployed works to
also be released under the AGPL. If you want to use this in a proprietary or
closed-source commercial product without those obligations, contact the copyright
holder about a separate commercial license.
