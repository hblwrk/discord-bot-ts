# discord-bot-js

## Conventions

* This is a TypeScript project <https://www.typescriptlang.org/>.
* The project follows a rolling release model <https://en.wikipedia.org/wiki/Rolling_release>.
* The `main` branch contains stable and tested code. Any development is done at feature branches.
* We use `git config pull.rebase false`.
* We do not commit any IDE, operating-system or editor-specific files to the repository, mind `.gitignore`.
* We use Airbnb's JS style guide <https://github.com/airbnb/javascript>. That's two spaces for indentation.

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
* Vulnerable dependencies are detected by Snyk.
* The container image is signed with cosign.
* The container gets redeployed by the server after calling a webhook and verifying its signature.

The webhook runs as a user-mode `systemd` service for user `mheiland`, all relevant configuration can be found at that user's home directory.

## Runtime environment

Docker swarm mode needs to be initialized once before being able to use it.

```bash
docker swarm init --listen-addr=127.0.0.1:2377
```

## Secrets

Configuration items like the Discord `token`, `guildId` and `clientId` are considered secrets and specific to each user running the bot. Those need to be specified prior to running `docker-compose`.

```bash
echo -n "hunter1" | docker secret create discord_token -
echo -n "hunter2" | docker secret create discord_clientId -
echo -n "hunter3" | docker secret create discord_guildId -
```

By defining a set of secrets per developer, multiple bots can be run at the same time based off different code streams. The code looks for `config.json` and expects the following syntax:

```json
{
  "discord_token": "hunter1",
  "discord_clientId": "hunter2",
  "discord_guildId": "hunter3"
}
```

## Service lifecycle

The bots lifecycle is managed using the `docker-compose.yml` file provided at this repository. It contains useful security settings, resource limits and injects secrets. The service is then deployed using Docker Swarm.

```bash
docker stack deploy --with-registry-auth --prune --compose-file docker-compose.yml discord-bot-js_production
docker stack rm discord-bot-js_production
```
