#!/usr/bin/env bash
# Checks the mechanical rules from AGENTS.md (lint job in CI):
#   ascii   comments and docs are ASCII only (string literals in code may use Unicode)
#   dash    no dash punctuation (U+2013, U+2014, " - " between words in comments and docs)
#   german  no German in comments and docs (word heuristic)
#   links   relative links in Markdown files resolve
#   executable shell scripts use set -euo pipefail
#   versions.env only KEY=VALUE, images with tag also by digest, full commits and SHA256
#   npm dependencies pinned exactly, all workspace packages share one version
#   actions pinned by commit SHA, only GitHub-hosted runners, the tailnet only in job deploy
# In engine/patches/ only added lines are checked. Exceptions: tools/check-style.allow.
set -euo pipefail
cd "$(dirname "$0")/.."
export LC_ALL=C

errors=0
error() {
    printf '%s\n' "$*" >&2
    errors=$((errors + 1))
}

allow_rules=()
allow_patterns=()
while read -r rule pattern _; do
    [[ -z "$rule" || "$rule" == \#* ]] && continue
    allow_rules+=("$rule")
    allow_patterns+=("$pattern")
done < tools/check-style.allow

allowed() { # <rule> <file>
    local i
    for i in "${!allow_rules[@]}"; do
        # shellcheck disable=SC2053 # the right side is a pattern
        [[ "${allow_rules[i]}" == "$1" && "$2" == ${allow_patterns[i]} ]] && return 0
    done
    return 1
}

check() { # <rule> <file> <pattern>
    local hits line
    if hits="$(grep -I -n -E -- "$3" "$2")"; then
        while IFS= read -r line; do error "$2:$line  [$1]"; done <<< "$hits"
    fi
}

nonascii=$'[\x80-\xff]'
dash=$'\xe2\x80\x93|\xe2\x80\x94'
spaced='[[:alpha:],.)] - [[:alpha:](]'
comment='(^[[:space:]]*\*|(^|[[:space:]])(//|#|/\*|<!--))'
# Frequent German words that are no English words; two of them in one line count
german_words='und|nicht|oder|wird|werden|fuer|ueber|keine|wenn|dann|beim|zum|zur|sind|auch|noch|bereits|einen|einer|eine|das|ist|mit|auf|aus|nach|bei|wie|nur'
german="(^|[^[:alnum:]_])($german_words)[^[:alnum:]_]+(.*[^[:alnum:]_])?($german_words)([^[:alnum:]_]|$)"

docs_file() { [[ "$1" == *.md || "$1" == *.txt ]]; }

mapfile -d '' files < <(git ls-files -z -- ':!:engine/patches/' ':!:third_party/')
for file in "${files[@]}"; do
    [ -f "$file" ] || continue
    if ! allowed ascii "$file"; then
        if docs_file "$file"; then
            check ascii "$file" "$nonascii"
        else
            check ascii "$file" "$comment.*$nonascii"
        fi
    fi
    allowed dash "$file" || check dash "$file" "$dash"
    if docs_file "$file"; then
        check dash "$file" "$spaced"
    else
        check dash "$file" "$comment.*$spaced"
    fi
    if ! allowed german "$file"; then
        if docs_file "$file"; then
            check german "$file" "$german"
        else
            check german "$file" "$comment.*$german"
        fi
    fi
done

# In the WebKit patches only the added lines are our text, the rest is WebKit
for patch in engine/patches/*.patch; do
    check_german=1
    allowed german "$patch" && check_german=0
    while IFS= read -r message; do error "$message"; done < <(
        NONASCII="$nonascii" DASH="$dash" SPACED="$spaced" COMMENT="$comment" GERMAN="$german" \
        awk -v file="$patch" -v check_german="$check_german" '
        /^\+\+\+ / || !/^\+/ { next }
        {
            text = substr($0, 2)
            if (text ~ ENVIRON["COMMENT"] ".*" ENVIRON["NONASCII"]) print file ":" FNR ":" text "  [ascii]"
            if (text ~ ENVIRON["DASH"] || text ~ (ENVIRON["COMMENT"] ".*" ENVIRON["SPACED"]))
                print file ":" FNR ":" text "  [dash]"
            if (check_german && text ~ (ENVIRON["COMMENT"] ".*" ENVIRON["GERMAN"]))
                print file ":" FNR ":" text "  [german]"
        }' "$patch")
done

# Relative links in Markdown: [text](path) must exist
for file in "${files[@]}"; do
    [[ "$file" == *.md && -f "$file" ]] || continue
    dir="$(dirname "$file")"
    while IFS= read -r target; do
        target="${target%%#*}"
        [ -z "$target" ] && continue
        [ -e "$dir/$target" ] || error "$file: broken link $target  [links]"
    done < <(grep -o -E '\]\([^)[:space:]]+\)' "$file" | sed -E 's/^\]\(//; s/\)$//' |
        grep -v -E '^(https?:|mailto:|#)' || true)
done

for file in "${files[@]}"; do
    [[ "$file" == *.sh && -x "$file" ]] || continue
    grep -q '^set -euo pipefail$' "$file" || error "$file: executable but without 'set -euo pipefail'"
done

declare -A pins
while IFS= read -r line; do
    [[ "$line" =~ ^(#.*)?$ ]] && continue
    if [[ ! "$line" =~ ^([A-Z0-9_]+)=([^[:space:]]+)$ ]]; then
        error "versions.env: invalid line: $line"
        continue
    fi
    key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    pins[$key]="$value"
    case "$key" in
        *_COMMIT) [[ "$value" =~ ^[0-9a-f]{40}$ ]] || error "versions.env: $key is not a full commit" ;;
        *_SHA256) [[ "$value" =~ ^[0-9a-f]{64}$ ]] || error "versions.env: $key is not a SHA256" ;;
        *_IMAGE) [[ "${value##*/}" != *:* || "$value" =~ @sha256:[0-9a-f]{64}$ ]] || error "versions.env: $key has a tag but no digest" ;;
    esac
done < versions.env
[[ "${pins[NODE_IMAGE]-}" == "node:${pins[NODE_VERSION]-}-"* ]] || error "versions.env: NODE_IMAGE does not match NODE_VERSION"

# npm: exact versions everywhere, one product version for all workspace packages
while IFS= read -r message; do error "$message"; done < <(node tools/check-packages.mjs)

while IFS=: read -r file line text; do
    [[ "$text" =~ uses:[[:space:]]*(\./|[^@[:space:]]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*v[0-9]) ]] ||
        error "$file:$line: action not pinned (uses: <action>@<commit> # <version>)"
done < <(grep -H -n -E '^[[:space:]]*(-[[:space:]]+)?uses:' .github/workflows/*.yml)

# Only GitHub-hosted runners. The job deploy of deploy.yml alone joins the tailnet (OIDC token,
# TS_ secrets), and that workflow never runs for pull requests.
for workflow in .github/workflows/*.yml; do
    while IFS= read -r message; do error "$message"; done < <(awk -v file="$workflow" '
        /^jobs:/ { injobs = 1; next }
        !injobs && /pull_request/ { pr = 1 }
        injobs && /^  [A-Za-z0-9_-]+:/ { job = $1; sub(/:$/, "", job); next }
        injobs && /runs-on:/ && !/runs-on:[[:space:]]*(ubuntu|windows|macos)-[0-9a-z.-]+[[:space:]]*$/ {
            print file ":" FNR ": runs-on must be a GitHub-hosted runner (ubuntu-..., windows-..., macos-...)"
        }
        injobs && (/id-token:[[:space:]]*write/ || /secrets\.TS_/) {
            tailnet++
            if (file != ".github/workflows/deploy.yml" || job != "deploy")
                print file ":" FNR ": only the job deploy in deploy.yml may join the tailnet"
        }
        END { if (tailnet && pr) print file ": a workflow that joins the tailnet must not run on pull_request" }' "$workflow")
done

if [ "$errors" -gt 0 ]; then
    echo "$errors violations of AGENTS.md (exceptions: tools/check-style.allow)" >&2
    exit 1
fi
echo "Style ok"
