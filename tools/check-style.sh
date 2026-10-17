#!/usr/bin/env bash
# Prueft die mechanischen Regeln aus AGENTS.md (Lint-Job der CI):
#   umlaut  keine echten Umlaute und kein Eszett
#   dash    keine Gedankenstriche (U+2013, U+2014, " - " zwischen Woertern in Kommentaren und Doku)
#   ausfuehrbare Shell-Skripte mit set -euo pipefail
#   versions.env nur KEY=VALUE, Images mit Tag auch per Digest, Commits und SHA256 vollstaendig
#   Actions per Commit-SHA, das Label des Runners im LAN steht nur im Job deploy, ohne Actions
# In patches/webkit/ gilt das nur fuer die hinzugefuegten Zeilen. Ausnahmen fuer umlaut und
# dash stehen in tools/check-style.allow.
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

allowed() { # <regel> <datei>
    local i
    for i in "${!allow_rules[@]}"; do
        # shellcheck disable=SC2053 # rechts steht ein Muster
        [[ "${allow_rules[i]}" == "$1" && "$2" == ${allow_patterns[i]} ]] && return 0
    done
    return 1
}

check() { # <regel> <datei> <muster>
    local hits line
    if hits="$(grep -I -n -E -- "$3" "$2")"; then
        while IFS= read -r line; do error "$2:$line  [$1]"; done <<< "$hits"
    fi
}

# Zeichen als Bytes, damit dieses Skript selber keine enthaelt
umlaut=$'\xc3\xa4|\xc3\xb6|\xc3\xbc|\xc3\x84|\xc3\x96|\xc3\x9c|\xc3\x9f'
dash=$'\xe2\x80\x93|\xe2\x80\x94'
spaced='[[:alpha:],.)] - [[:alpha:](]'
comment='(^[[:space:]]*\*|(^|[[:space:]])(//|#|/\*|<!--))'

mapfile -d '' files < <(git ls-files -z -- ':!:patches/' ':!:third_party/')
for file in "${files[@]}"; do
    [ -f "$file" ] || continue
    for rule in umlaut dash; do
        if [ "$rule" = umlaut ]; then chars="$umlaut"; else chars="$dash"; fi
        if allowed "$rule" "$file"; then
            check "$rule" "$file" "$comment.*($chars)"
        else
            check "$rule" "$file" "$chars"
        fi
    done
    case "$file" in
        *.md) check dash "$file" "$spaced" ;;
        *) check dash "$file" "$comment.*$spaced" ;;
    esac
done

# In den WebKit-Patches sind nur die hinzugefuegten Zeilen unser Text, der Rest ist WebKit
for patch in patches/webkit/*.patch; do
    only_comments=0
    allowed umlaut "$patch" && only_comments=1
    while IFS= read -r message; do error "$message"; done < <(
        UMLAUT="$umlaut" DASH="$dash" SPACED="$spaced" COMMENT="$comment" awk -v file="$patch" -v only_comments="$only_comments" '
        /^\+\+\+ / || !/^\+/ { next }
        {
            text = substr($0, 2)
            comment = text ~ ENVIRON["COMMENT"]
            if ((comment || !only_comments) && text ~ ENVIRON["UMLAUT"])
                print file ":" FNR ":" text "  [umlaut]"
            if (text ~ ENVIRON["DASH"] || text ~ (ENVIRON["COMMENT"] ".*" ENVIRON["SPACED"]))
                print file ":" FNR ":" text "  [dash]"
        }' "$patch")
done

for file in "${files[@]}"; do
    [[ "$file" == *.sh && -x "$file" ]] || continue
    grep -q '^set -euo pipefail$' "$file" || error "$file: ausfuehrbar, aber ohne 'set -euo pipefail'"
done

declare -A pins
while IFS= read -r line; do
    [[ "$line" =~ ^(#.*)?$ ]] && continue
    if [[ ! "$line" =~ ^([A-Z0-9_]+)=([^[:space:]]+)$ ]]; then
        error "versions.env: ungueltige Zeile: $line"
        continue
    fi
    key="${BASH_REMATCH[1]}" value="${BASH_REMATCH[2]}"
    pins[$key]="$value"
    case "$key" in
        *_COMMIT) [[ "$value" =~ ^[0-9a-f]{40}$ ]] || error "versions.env: $key ist kein voller Commit" ;;
        *_SHA256) [[ "$value" =~ ^[0-9a-f]{64}$ ]] || error "versions.env: $key ist kein SHA256" ;;
        *_IMAGE) [[ "${value##*/}" != *:* || "$value" =~ @sha256:[0-9a-f]{64}$ ]] || error "versions.env: $key hat einen Tag, aber keinen Digest" ;;
    esac
done < versions.env
[[ "${pins[NODE_IMAGE]-}" == "node:${pins[NODE_VERSION]-}-"* ]] || error "versions.env: NODE_IMAGE passt nicht zu NODE_VERSION"

while IFS=: read -r file line text; do
    [[ "$text" =~ uses:[[:space:]]*(\./|[^@[:space:]]+@[0-9a-f]{40}[[:space:]]+#[[:space:]]*v[0-9]) ]] ||
        error "$file:$line: Action nicht gepinnt (uses: <action>@<commit> # <version>)"
done < <(grep -H -n -E '^[[:space:]]*(-[[:space:]]+)?uses:' .github/workflows/*.yml)

for workflow in .github/workflows/*.yml; do
    while IFS= read -r message; do error "$message"; done < <(awk -v file="$workflow" '
        /^jobs:/ { injobs = 1; next }
        !injobs && /pull_request/ { pr = 1 }
        injobs && /^  [A-Za-z0-9_-]+:/ { job = $1; sub(/:$/, "", job); next }
        injobs && /browser-lite-deploy/ {
            lan[job] = 1; count++
            if (file != ".github/workflows/deploy.yml" || job != "deploy")
                print file ":" FNR ": nur der Job deploy in deploy.yml darf den Runner im LAN nutzen"
        }
        injobs && /^[[:space:]]*(-[[:space:]]+)?uses:/ && !(job in uses) { uses[job] = FNR }
        END {
            for (j in lan) if (j in uses) print file ":" uses[j] ": Job " j " laeuft im LAN und darf keine Action nutzen"
            if (count && pr) print file ": Workflow mit dem Runner im LAN darf nicht bei pull_request laufen"
        }' "$workflow")
done

if [ "$errors" -gt 0 ]; then
    echo "$errors Verstoesse gegen AGENTS.md (Ausnahmen: tools/check-style.allow)" >&2
    exit 1
fi
echo "Stil ok"
