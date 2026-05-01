# discord-bot-ts

## Conventions

* This is a TypeScript 6 project using ECMAScript modules with TypeScript's NodeNext module system, an ESNext target, native Node.js TypeScript runtime support, and strict compiler settings <https://www.typescriptlang.org/>.
* Tests run on Vitest with explicit imports, native Vite-powered TypeScript transforms and V8 coverage.
* The project follows a rolling release model <https://en.wikipedia.org/wiki/Rolling_release>.
* The `main` branch contains stable and tested code. Any development is done at feature branches.
* We use `git config pull.rebase false`.
* Mind `.gitignore`.
* Code style follows the surrounding file: two-space indentation, double quotes, and explicit readable control flow.
* Linting uses ESLint flat config with type-aware `typescript-eslint`, `@vitest/eslint-plugin` for tests, and `eslint-plugin-n` for Node.js runtime checks.

## Running

Install Node.js 24 LTS and start the bot like this:

```bash
npm install
node index.ts
```

## Workflow

As a developer, I want to add a new feature or fix a bug. I therefore make sure to fetch the latest code at the `main` branch.

```bash
git checkout main
git pull
```

Now I create a new branch, the naming shows my intention.

```bash
git branch add_command_help
git checkout add_command_help
```

Now I apply my changes and make sure they are working. I may commit and push to the feature branch `add_command_help` and test the change by setting up the bot based on this branch. Every change gets committed and a meaningful commit message is added. I push to a remote branch that matches the name of my local branch.

```bash
git commit -am "Added documentation for the the help command"
git push --set-upstream origin add_command_help
```

Once my change is complete, I start a pull-request to get my changes to the `main` branch and add more details about my change if needed.

* <https://github.com/hblwrk/discord-bot-ts/pull/new/add_command_help>

After the pull-request has been merged, i remove the feature branch and switch back to the `main` branch and pull in the merged changes.

```bash
git checkout main
git pull
```

## CI/CD

The bot is deployed at our server, running as a docker container in Docker Swarm using compose files. Every time the `main` branch gets updated, the GitHub Actions workflows make sure that:

* Software tests and type checks are executed (`npm run test:coverage`, `npm run typecheck`).
* The `Dockerfile` is validated and checked against CIS benchmark rules.
* Security scanning in the main workflow is executed using Checkov.
* Additional security scanning is handled by dedicated CodeQL, njsscan and Semgrep workflows.
* The container image is built, pushed and signed with cosign.
* The server gets notified via webhook with the image digest and commit SHA to deploy.
* The server-side redeploy script verifies that exact image digest and commit binding, then only deploys production after staging reports `/api/v1/ready`.

The webhook runs as a user-mode `systemd` service for user `mheiland`, all relevant configuration can be found at that user's home directory.

Relevant activities like production deployment are reported to a channel at Discord.

## Runtime environment

On our server, Docker swarm mode needs to be initialized once before being able to use it. This is not required for local development.

```bash
docker swarm init --listen-addr=127.0.0.1:2377
```

Containers are created by multi-stage builds based on "distroless" base-images. Anything which is not required to operate the bot has been removed, for example a shell and system tools. As a result, images are very small, have little attack surface and their file-system is mounted read-only.

## Secrets

Values like the bots `token`, `guild_ID` and `client_ID` are considered secrets and specific to each user running the bot. When using Docker, those need to be specified prior to running `docker-compose`. Mind that there is a specific set of values for both production and staging environments, identified by the corresponding prefix. Runtime secret resolution is environment-scoped: mount exactly one of `production_environment` or `staging_environment`, and the bot will only read secrets from that active prefix. Mounting both prefixes or omitting the environment secret is treated as a startup error.

```bash
echo -n "hunter0" | docker secret create production_environment -
echo -n "hunter1" | docker secret create production_discord_token -
echo -n "hunter2" | docker secret create production_discord_client_ID -
echo -n "hunter3" | docker secret create production_discord_guild_ID -
echo -n "hunter4" | docker secret create production_dracoon_password -
echo -n "hunter5" | docker secret create production_hblwrk_channel_NYSEAnnouncement_ID -
echo -n "hunter6" | docker secret create production_hblwrk_gainslosses_thread_ID -
echo -n "hunter7" | docker secret create production_hblwrk_channel_MNCAnnouncement_ID -
echo -n "hunter8" | docker secret create production_hblwrk_channel_OtherAnnouncement_ID -
echo -n "hunter9" | docker secret create production_discord_btcusd_token -
echo -n "hunter10" | docker secret create production_discord_btcusd_client_ID -
...
```

Check the `config.json` example below for a reference set of configuration parameters. Keep it in sync with key references in `assets/*.yaml` and secrets in `tools/docker-compose-production.yml`.

The `/delta` command reads `tastytrade_client_secret` and `tastytrade_refresh_token` only when the command is used. Deployments without these secrets start normally and return a not-configured response for `/delta`.

By defining a set of secrets per developer, multiple bots can be run at the same time based off different code streams. When running outside of Docker, the code looks for `config.json` and expects the following syntax. Mind that all values which are not set in this example require some sort of password or Discord bot- or server-specific ID.

`loglevel` is optional and defaults to `info`. Supported values are `error`, `warn`, `info`, `http`, `verbose`, `debug` and `silly`.  
In Docker-based deployments without `config.json`, you can override this with the `LOGLEVEL` environment variable.
The health-check server port can be overridden via the `HEALTHCHECK_PORT` environment variable and defaults to `11312`.

```json
{
  "environment": "staging",
  "loglevel": "info",
  "discord_token": "",
  "discord_client_ID": "",
  "discord_guild_ID": "",
  "discord_btcusd_token": "",
  "discord_btcusd_client_ID": "",
  "discord_ethusd_token": "",
  "discord_ethusd_client_ID": "",
  "discord_solusd_token": "",
  "discord_solusd_client_ID": "",
  "discord_oneusd_token": "",
  "discord_oneusd_client_ID": "",
  "discord_es_token": "",
  "discord_es_client_ID": "",
  "discord_nq_token": "",
  "discord_nq_client_ID": "",
  "discord_rty_token": "",
  "discord_rty_client_ID": "",
  "discord_vix_token": "",
  "discord_vix_client_ID": "",
  "discord_dax_token": "",
  "discord_dax_client_ID": "",
  "discord_cl_token": "",
  "discord_cl_client_ID": "",
  "discord_xau_token": "",
  "discord_xau_client_ID": "",
  "discord_eurusd_token": "",
  "discord_eurusd_client_ID": "",
  "discord_2y_token": "",
  "discord_2y_client_ID": "",
  "discord_10y_token": "",
  "discord_10y_client_ID": "",
  "discord_30y_token": "",
  "discord_30y_client_ID": "",
  "tastytrade_client_secret": "",
  "tastytrade_refresh_token": "",
  "dracoon_password": "",
  "hblwrk_channel_NYSEAnnouncement_ID": "",
  "hblwrk_gainslosses_thread_ID": "",
  "hblwrk_channel_MNCAnnouncement_ID": "",
  "hblwrk_channel_OtherAnnouncement_ID": "",
  "hblwrk_channel_logging_ID": "",
  "hblwrk_channel_clownboard_ID": "",
  "hblwrk_role_assignment_channel_ID": "",
  "hblwrk_role_assignment_broker_message_ID": "",
  "hblwrk_role_assignment_special_message_ID": "",
  "hblwrk_role_broker_yes_ID": "",
  "hblwrk_role_broker_tastyworks_ID": "",
  "hblwrk_role_broker_ibkr_ID": "",
  "hblwrk_role_broker_traderepublic_ID": "",
  "hblwrk_role_broker_smartbroker_ID": "",
  "hblwrk_role_broker_scalablecapital_ID": "",
  "hblwrk_role_broker_etoro_ID": "",
  "hblwrk_role_broker_hausbank_ID": "",
  "hblwrk_role_broker_comdirect_ID": "",
  "hblwrk_role_broker_degiro_ID": "",
  "hblwrk_role_broker_flatex_ID": "",
  "hblwrk_role_broker_onvista_ID": "",
  "hblwrk_role_broker_schwab_ID": "",
  "hblwrk_role_broker_none_ID": "",
  "hblwrk_role_broker_other_ID": "",
  "hblwrk_role_special_etf_ID": "",
  "hblwrk_role_special_1euroladen_ID": "",
  "hblwrk_role_special_commodities-fx-bonds_ID": "",
  "hblwrk_role_special_crypto_ID": "",
  "hblwrk_role_special_steuerkanzlei_ID": "",
  "hblwrk_role_special_business-karriere_ID": "",
  "hblwrk_role_special_content-creator-squad_ID": "",
  "hblwrk_role_special_alerts_ID": "",
  "hblwrk_role_special_nftping_ID": "",
  "hblwrk_role_special_stageping_ID": "",
  "hblwrk_role_special_realestate_ID": "",
  "hblwrk_role_muted_ID": ""
}
```

## Assets

Larger files, for example images, are stored at an external cloud service, Dracoon. They are requested by the bot and uploaded as attachment to Discord. This avoids high bandwidth cost for us as well as messing up our repository with binary files. Access to such assets requires to know the asset ID and a password. A reference and metadata for each asset is stored at `assets/`. Discord limits uploads to 8MB.

If DRACOON downloads fail during startup, the bot keeps those assets marked as temporarily unavailable, logs the failures at `WARN`, and retries failed downloads in the background with capped exponential backoff (starting at 60 seconds, max 30 minutes) until recovery.

### Reminder assets

Calendar reminders, earnings reminders, and earnings result announcements post into `hblwrk_channel_OtherAnnouncement_ID`. Earnings result announcements are sent after a matching SEC EDGAR filing appears. Result announcements include an `Outlook` block when the filing has an explicit outlook or guidance section. They ping the `alerts` special role, which is self-assignable from the roles channel via the `🛎️` bellhop bell reaction on the special roles message.

Calendar reminder assets are matched against the current day and sent at `08:30 Europe/Berlin`, immediately after the general daily calendar post. If multiple matching calendar items share the same release minute, the bot bundles them into a single reminder ping:

```yaml
---
- name: us-cpi-1h
  eventNameSubstrings:
    - "consumer price index"
    - "cpi"
  countryFlags:
    - "🇺🇸"
  roleIdReference: "hblwrk_role_special_alerts_ID"
```

Earnings reminders use same-day ticker heads-ups at `08:00 Europe/Berlin` on weekdays:

```yaml
---
- name: sp500-top20-earnings
  tickerSymbols:
    - "NVDA"
    - "AAPL"
    - "MSFT"
  roleIdReference: "hblwrk_role_special_alerts_ID"
```

Example Discord output:

```text
@alerts Heute wichtig: `14:30` 🇺🇸 Consumer Price Index (CPI)
@alerts Heute Earnings: `AAPL` (nach Handelsschluss)
@alerts Heute Earnings: `NVDA`, `MSFT` (nach Handelsschluss)
💰 **Earnings: Apple Inc. (`AAPL`) Q1 2026**
EPS: `$2.84` vs est. `$2.67` - beat
Revenue: `$143.8B` vs est. `$138.25B` - beat
SEC: 8-K Item 2.02, 9.01 https://www.sec.gov/Archives/edgar/data/320193/000032019326000005/a8-kex991q1202612272025.htm
```

## Market data

Real-time market-data is being pulled in through a Websocket connection and distributed via Discord bot nickname and presence information. Those bots can be joined to the server separately and their runtime information is managed as an asset. They require no oAuth2 scopes other than "bot".

The `/delta` command uses tastytrade OAuth read access for option chains and live quote-streamer snapshots. It selects the first expiration on or after the requested DTE and returns the call and put strikes around the requested absolute delta, including bid, mid, ask, size and IV.

## Service lifecycle

The bots lifecycle is managed using the `tools/docker-compose-production.yml` file provided at this repository. It contains useful security settings, resource limits and injects secrets. The service is then deployed using Docker Swarm.

```bash
DISCORD_BOT_IMAGE="ghcr.io/hblwrk/discord-bot-ts@sha256:<digest>" \
docker stack deploy --with-registry-auth --prune --compose-file tools/docker-compose-production.yml discord-bot-ts_production
docker stack rm discord-bot-ts_production
```

## Monitoring

Our containers are designed to be minimal and include an in-container health-check in the `Dockerfile`, probing `/api/v1/health` for liveness. The bot exposes a simple HTTP server at the port configured by `HEALTHCHECK_PORT` (`11312/tcp` by default) with:

* `/api/v1/health`: liveness endpoint (returns `HTTP 200` when process is running).
* `/api/v1/ready`: readiness endpoint (returns `HTTP 200` only after Discord login, handler setup and successful remote warmup, otherwise `HTTP 503`).
* `/api/v1/startup`: startup diagnostics.

The redeploy automation waits for `/api/v1/ready` before production rollout. Service availability monitoring is provided by HetrixTools <https://hetrixtools.com/report/uptime/7162c65d5357013beb43868c30e86e6a/>.

Unavailability will be reported to a channel at Discord.

## Discord Developer settings

### Create a bot

In order to create a bot, a Discord Application needs to be created at <https://discord.com/developers/>. Select "New Application", give it a brief identifier, and fetch the "Application ID" value from the following page. This is used at the bot configuration to authenticate at Discord.

Select Settings -> Bot, select "Add bot" and give the bot a proper name, image etc. Also disable "Public Bot". Click "Reveal Token" to show the bots' authentication token. This is used at the bots' configuration to authenticate at Discord.

Permissions of the bot are granted using OAuth2 scopes. Select Settings -> OAuth2 and enable at least the following OAuth2 scopes:

* bot
* application.commands

Also make sure the bot has sufficient "bot" permissions (534992256064) before inviting:

General

* View Channels
* Manage Roles

Text

* Send Messages
* Public Threads
* Private Threads
* Send Messages in Threads
* Send TTS Messages
* Manage Messages
* Manage Threads
* Embed Links
* Attach Files
* Read Message History
* Use External Emojis
* Use External Stickers
* Add Reactions
* Use Slash Commands

Open the generated URL starting with <https://discord.com/api/oauth2/authorize?client_id=...> to invite your bot to a specific server.

At the Discord client go to "Server Settings" and add the bot to a role. Move that role to the top of the list to make sure the bot can assign and remove roles of members which have roles that are visually "below" the bots role.

To get a server's Guild ID, enable Developer Mode at the Discord Client at User Settings -> App Settings -> Advanced. Then exit the settings menu and right-click the server name and click "Copy ID". This is used at the bot configuration to define which server to connect to.

You will need the Application ID, the Bot Token and the Guild ID to authenticate and use your bot.

### Interact with the bot

Once the bot has joined your server make sure to use a dedicated channel for development. If multiple bots of the same kind are present at a single channel, they may all respond to commands. You can invite your bot to your dedicated channel by using channel permissions.
