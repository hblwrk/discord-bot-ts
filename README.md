# discord-bot-js

## Conventions

* This is a ES6, TypeScript project <https://www.typescriptlang.org/>.
* The project follows a rolling release model <https://en.wikipedia.org/wiki/Rolling_release>.
* The `main` branch contains stable and tested code. Any development is done at feature branches.
* We use `git config pull.rebase false`.
* We do not commit any IDE, operating-system or editor-specific files to the repository, mind `.gitignore`.
* We use Airbnb's JS style guide <https://github.com/airbnb/javascript>. That's two spaces for indentation.
* Consider using ESLint/XO <https://github.com/xojs/xo> for linting.

## Running

Install NodeJS v16 or newer and start the bot like this:

```bash
npm install
node --loader ts-node/esm index.ts
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

* <https://github.com/hblwrk/discord-bot-js/pull/new/add_command_help>

After the pull-request has been merged, i remove the feature branch and switch back to the `main` branch and pull in the merged changes.

```bash
git checkout main
git pull
```

## CI/CD

The bot is deployed at our hblwrk.de server, running as a docker container and managed using `docker-compose`. Every time the `main` branch gets updated, our GitHub Actions CI pipeline makes sure that:

* Software tests are executed
* The `Dockerfile` is valid and conforms to CIS Docker Benchmark requirements sections 4.1, 4.2, 4.3, 4.6, 4.7, 4.9 and 4.10.
* Vulnerable dependencies are detected by Snyk <https://app.snyk.io/org/mheiland/project/f29b4f0d-7800-4b9c-882f-036af6a21921>.
* The container image is signed with cosign.
* The server gets notified via webhook to start deployment.
* The server verifies the container signature when deploying.

The webhook runs as a user-mode `systemd` service for user `mheiland`, all relevant configuration can be found at that user's home directory.

Relevant activities like deployment to production and merging pull-requests is being reported to the #development channel at Discord.

## Runtime environment

Docker swarm mode needs to be initialized once before being able to use it.

```bash
docker swarm init --listen-addr=127.0.0.1:2377
```

Containers are created by multi-stage builds based on "distroless" base-images. Anything which is not required to operate the bot has been removed, for example a shell and system tools. As a result, images are very small, have little attack surface and their file-system is mounted read-only.

## Secrets

Values like the bots `token`, `guildID` and `clientID` are considered secrets and specific to each user running the bot. Those need to be specified prior to running `docker-compose`.

```bash
echo -n "hunter1" | docker secret create discord_token -
echo -n "hunter2" | docker secret create discord_clientID -
echo -n "hunter3" | docker secret create discord_guildID -
echo -n "hunter4" | docker secret create dracoon_password -
echo -n "hunter5" | docker secret create hblwrk_NYSEAnnouncement_ChannelID -
echo -n "hunter6" | docker secret create hblwrk_MNCAnnouncement_ChannelID -
echo -n "hunter7" | docker secret create hblwrk_OtherAnnouncement_ChannelID -
```

By defining a set of secrets per developer, multiple bots can be run at the same time based off different code streams. The code looks for `config.json` and expects the following syntax:

```json
{
  "discord_token": "hunter1",
  "discord_clientID": "hunter2",
  "discord_guildID": "hunter3",
  "dracoon_password": "hunter4",
  "hblwrk_NYSEAnnouncement_ChannelID": "hunter5",
  "hblwrk_MNCAnnouncement_ChannelID": "hunter6",
  "hblwrk_OtherAnnouncement_ChannelID": "hunter7"
}
```

## Assets

Larger files, for example images, are stored at an external cloud service, Dracoon. They are requested by the bot and uploaded as attachment to Discord. This avoids high bandwidth cost for us as well as messing up our repository with binary files. Access to such assets requires to know the asset ID and a password. A reference and metadata for each asset is stored at `assets/`. Discord limits uploads to 8MB.

## Service lifecycle

The bots lifecycle is managed using the `docker-compose.yml` file provided at this repository. It contains useful security settings, resource limits and injects secrets. The service is then deployed using Docker Swarm.

```bash
docker stack deploy --with-registry-auth --prune --compose-file docker-compose.yml discord-bot-js_production
docker stack rm discord-bot-js_production
```

## Monitoring

Our containers are designed to be minimal, which comes with the downside that we cannot run in-container health-checks. The bot exposes a simple HTTP server at port `11312/tcp`, providing the path `/api/v1/health` which responds with `HTTP 200` if the bot is running. Service availability monitoring is provided by HetrixTools <https://hetrixtools.com/report/uptime/7162c65d5357013beb43868c30e86e6a/>.

Unavailability will be reported to the #development channel at Discord.

## Discord Developer settings

### Create a bot

In order to create a bot, a Discord Application needs to be created at <https://discord.com/developers/>. Select "New Application", give it a brief identifier, and fetch the "Application ID" value from the following page. This is used at the bot configuration to authenticate at Discord.

Select Settings -> Bot, select "Add bot" and give the bot a proper name, image etc. Also disable "Public Bot". Click "Reveal Token" to show the bots' authentication token. This is used at the bots' configuration to authenticate at Discord.

Permissions of the bot are granted using OAuth2 scopes. Select Settings -> OAuth2 and enable at least the following OAuth2 scopes:

* bot
* application.commands

Open the generated URL starting with <https://discord.com/api/oauth2/authorize?client_id=...> to invite your bot to a specific server.

To get a server's Guild ID, enable Developer Mode at the Discord Client at User Settings -> App Settings -> Advanced. Then exit the settings menu and right-click the server name and click "Copy ID". This is used at the bot configuration to define which server to connect to.

You will need the Application ID, the Bot Token and the Guild ID to authenticate and use your bot.

### Interact with the bot

Once the bot has joined your server make sure to use a dedicated channel for development. If multiple bots of the same kind are present at a single channel, they may all respond to commands. You can invite your bot to your dedicated channel by using channel permissions.
