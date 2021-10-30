# discord-bot-js

## Conventions

* This is a TypeScript project <https://www.typescriptlang.org/>.
* The project follows a rolling release model <https://en.wikipedia.org/wiki/Rolling_release>.
* The `main` branch contains stable and tested code. Any development is done at feature branches.
* We use `git config pull.rebase false`.
* We do not commit any IDE, operating-system or editor-specific files to the repository, mind `.gitignore`.
* We use Airbnb's JS styleguide <https://github.com/airbnb/javascript>. Thats two spaces for indentation.

## Workflow

As a developer, i want to add a new feature or fix a bug. I therefore make sure to fetch the latest code at the `main` branch.

```bash
git checkout main
git pull
```

Now i create a new branch, the naming shows my intention.

```bash
git branch add_command_help
git checkout add_command_help
```

Now i apply my changes and make sure they are working. I may commit and push to the feature branch `add_command_help` and test the change by setting up the bot based on this branch. Every change gets committed and a meaningful commit message is added. I push to a remote branch that matches the name of my local branch.

```bash
git commit -am "Added documentation for the the help command"
git push --set-upstream origin add_command_help
```

Once my change is complete, i start a pull-request to get my changes to the `main` branch and add more details about my change if needed.

* <https://github.com/hblwrk/discord-bot-js/pull/new/add_command_help>

Remove the feature branch afterwards. Switch back to the `main` branch and pull in the merged changes.

```bash
git checkout main
git pull
```

## CI/CD

The bot is deployed at our hblwrk.de server, running as a docker container. Everytime the `main` branch gets updated, our GitHub Actions CI pipeline makes sure that:

* Software tests are executed
* The `Dockerfile` is valid and conforms to CIS Docker Benchmark requirements sections 4.1, 4.2, 4.3, 4.6, 4.7, 4.9 and 4.10.
* No vulnerable dependencies are used by our code by scanning with Snyk.
* The container gets redeployed by the server after calling a webhook.

The webhook runs as a user-mode `systemd` service for user `mheiland`, all relevant configuration can be found at that users home directory.
