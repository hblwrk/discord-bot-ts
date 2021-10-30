# discord-bot-js

## Convention

* This is a TypeScript project <https://www.typescriptlang.org/>.
* The project follows a rolling release model <https://en.wikipedia.org/wiki/Rolling_release>.
* The `main` branch contains stable and tested code. Any development is done at feature branches.
* We use `git config pull.rebase false`

## Workflow

As a developer, i want to add a new feature or fix a bug. I therefore make sure to fetch the latest code at the `main` branch.

 $ git checkout main
 $ git pull

Now i create a new branch, the naming shows my intention.

 $ git branch add_command_help
 $ git checkout add_command_help

Now i apply my changes and make sure they are working. I may commit and push to the feature branch `add_command_help` and test the change by setting up the bot based on this branch. Every change gets committed and a meaningful commit message is added.

  $ git commit -am "Added documentation for the the help command"
  $ git push

Once my change is complete, i start a merge-request to get my changes to the `main` branch.