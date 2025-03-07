#!/usr/bin/env bash

if [[ -z ${1} ]]; then
    echo "A git commit must be supplied as the first parameter."
    exit 1
else
    GIT_COMMIT=${1}
fi

if [[ $(whoami) != "circleci" ]]; then
    echo "This script is intended to be run through CI."
    echo "Please see:"
    echo "    .circleci/bin/deploy-sdk.sh -h"
    exit 1
fi

set -ex

# Generate change log between last released sha and HEAD
function git-changelog () {
    release_commit=${1}

    # Print the log as "- <commmiter short date> [<commit short hash>] <commit message> <author name>"
    git log --pretty=format:"- %cd [%h] %s [%an]" --date=short $release_commit..HEAD .
}

# formats a commit message using the bumped ${VERSION} and ${CHANGE_LOG}
function commit-message () {
    echo "Bump ${STUB} to ${VERSION}

## Changelog

${CHANGE_LOG}"
}

# Pull in master, ensure commit is on master, ensure clean build environment
function git-reset () {
    (
        # Configure git client
        git config --global user.email "audius-infra@audius.co"
        git config --global user.name "audius-infra"

        # Make sure master is up to date
        git checkout master -f
        git pull

        if [[ "${GIT_COMMIT}" == "master" ]]; then
            echo "Commit cannot be 'master'."
            exit 1
        fi

        # only allow commits found on master or release branches to be deployed
        echo "commit has to be on master or a release branch"
        git branch -a --contains ${GIT_COMMIT} \
            | tee /dev/tty \
            | grep -Eq 'remotes/origin/master|remotes/origin/release' \
            || exit 1

        # Ensure working directory clean
        git reset --hard ${GIT_COMMIT}
    )
}

# Make a new branch off GIT_COMMIT, bumps npm,
# commits with the relevant changelog, and pushes
function bump-version () {
    (
        # Patch the version
        VERSION=$(npm version patch)
        tmp=$(mktemp)
        jq ". += {audius: {releaseSHA: \"${GIT_COMMIT}\"}}" package.json > "$tmp" \
            && mv "$tmp" package.json

        # Build project
        npm i
        npm run build

        # Publishing dry run, prior to pushing a branch
        npm publish . --access public --dry-run

        # Commit to a new branch
        git checkout -b ${STUB}-${VERSION}
        git add .
        git commit -m "$(commit-message)"

        # Push branch to remote
        git push -u origin ${STUB}-${VERSION}
    )
}

# Merge the created branch into master, then delete the branch
function merge-bump () {
    (
        git checkout master -f

        # pull in any additional commits that may have trickled in
        git pull

        # squash branch commit
        git merge --squash ${STUB}-${VERSION} || exit 1
        git commit -m "$(commit-message)" || exit 1

        # tag release
        git tag -a @audius/${STUB}@${VERSION} -m "$(commit-message)" || exit 1
        git push origin --tags || exit 1

        # if pushing fails, ensure we cleanup()
        git push -u origin master || exit 1
        git push origin :${STUB}-${VERSION}
    )
}

# publish to npm
function publish () {
    npm publish . --access public
}

# informative links
function info () {
    echo "Released to:
      https://github.com/AudiusProject/audius-protocol/commits/master
      https://github.com/AudiusProject/audius-protocol/tags
      https://www.npmjs.com/package/@audius/sdk?activeTab=versions"
}

# cleanup when merging step fails
function cleanup () {
    git push origin :${STUB}-${VERSION} || true
    git push --delete origin @audius/${STUB}@${VERSION} || true
    exit 1
}

# configuration
STUB=sdk
cd ${PROTOCOL_DIR}/libs

# pull in master
git-reset

# grab change log early, before the version bump
LAST_RELEASED_SHA=$(jq -r '.audius.releaseSHA' package.json)
CHANGE_LOG=$(git-changelog ${LAST_RELEASED_SHA})

# perform version bump and perform publishing dry-run
bump-version

# grab VERSION again since we escaped the bump-version subshell
VERSION=v$(jq -r '.version' package.json)

merge-bump && publish && info || cleanup
