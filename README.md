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
