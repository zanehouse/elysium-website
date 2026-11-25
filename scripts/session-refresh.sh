#!/usr/bin/env bash
# session-refresh.sh — drive one US market session's worth of data refreshes
# from inside a single GitHub Actions job.
#
# Why a loop instead of a `*/15` cron: GitHub silently drops most high-frequency
# schedule ticks. `*/15 13-20 * * 1-5` asks for 32 runs/day and reliably
# delivered only ~6, spaced 90-106 minutes apart. Depending on two cron
# deliveries per day instead of thirty-two is what makes the cadence real.
#
# Market hours are evaluated in America/New_York inside the loop rather than
# baked into the cron's UTC hours, so DST needs no maintenance: in EST the
# morning job simply idles for its first hour instead of missing the close.
#
# Env:
#   DEADLINE_UTC  HHMM UTC to stop looping (required)
#   INTERVAL_SEC  seconds between refreshes            (default 900)
#   OPEN_ET       HHMM ET, earliest refresh            (default 0925)
#   EOD_ET        HHMM ET, take the EOD snapshot       (default 1615)
#   LAST_ET       HHMM ET, latest intraday refresh     (default 1620)
#   DRY_RUN       1 = trace the schedule, run no node/git
#
# Deliberately not `set -e`: a single failed fetch or a rejected push must not
# end the session. Per-symbol failures are already handled in
# build-market-data.mjs; this loop just has to survive them.
set -uo pipefail

INTERVAL_SEC="${INTERVAL_SEC:-900}"
OPEN_ET="${OPEN_ET:-0925}"
EOD_ET="${EOD_ET:-1615}"
LAST_ET="${LAST_ET:-1620}"
DRY_RUN="${DRY_RUN:-0}"
: "${DEADLINE_UTC:?DEADLINE_UTC (HHMM UTC) is required}"

# HHMM strings are octal-ambiguous in bash arithmetic ("0925" would be an
# invalid octal literal), so force base 10 on every comparison.
num() { echo $((10#$1)); }

now_utc() { date -u +%H%M; }

# Eastern time via Node, not `TZ=America/New_York date`. Some shells (notably
# Git Bash on Windows) ship no tzdata and *silently* fall back to UTC, which
# would put the market-hours gate four hours out and fire the EOD snapshot
# mid-session. Node bundles full ICU, so this is correct everywhere.
now_et() {
  node -e "process.stdout.write(new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date()).replace(':',''))"
}

log() { echo "[$(date -u +%H:%M:%S)Z / $(now_et)ET] $*"; }

# Resolve once. `--abbrev-ref HEAD` yields the literal "HEAD" on a detached
# checkout, which would make the rebase below target a branch that doesn't
# exist, so fall back to the remote's default.
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null)}"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  BRANCH=$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##')
  BRANCH="${BRANCH:-main}"
fi

commit_and_push() {
  local msg="$1"
  git add assets/data
  if git diff --cached --quiet; then
    log "no data changes, nothing to commit"
    return 0
  fi
  git commit -q -m "$msg" || { log "commit failed"; return 1; }

  # The daily-data workflow pushes to the same branch. Neither used to rebase,
  # so a collision silently discarded a whole run's data.
  for _ in 1 2 3 4 5; do
    if git push -q origin "HEAD:$BRANCH" 2>/dev/null; then
      log "pushed to $BRANCH"
      return 0
    fi
    log "push rejected, rebasing on origin/$BRANCH"
    git pull --rebase --autostash -q origin "$BRANCH" || break
    sleep $((RANDOM % 5 + 2))
  done
  log "push failed after retries"
  return 1
}

refresh() {
  local mode="$1"   # intraday | eod
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN: would run build-market-data.mjs ${mode/intraday/}"
    return 0
  fi
  if [ "$mode" = "eod" ]; then
    node build-market-data.mjs --eod || { log "EOD build failed"; return 1; }
    commit_and_push "chore(data): refresh EOD snapshot [skip ci]"
  else
    node build-market-data.mjs || { log "intraday build failed"; return 1; }
    commit_and_push "chore(data): refresh market data [skip ci]"
  fi
}

# Fail loudly rather than silently scheduling against the wrong clock: if ICU
# can't resolve America/New_York it reports UTC, and every gate below would be
# 4-5 hours out.
if ! node -e "
  const z = new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',timeZoneName:'short'}).format(new Date());
  if (!/EDT|EST/.test(z)) { console.error('Eastern time unavailable, got: ' + z); process.exit(1); }
"; then
  echo "FATAL: cannot resolve America/New_York; refusing to run on an unverified clock" >&2
  exit 1
fi

eod_done=0
log "session start — deadline ${DEADLINE_UTC}Z, every ${INTERVAL_SEC}s, window ${OPEN_ET}-${LAST_ET} ET"

while :; do
  u=$(num "$(now_utc)")
  e=$(num "$(now_et)")

  if [ "$u" -ge "$(num "$DEADLINE_UTC")" ]; then
    log "deadline reached, ending session"
    break
  fi

  if [ "$e" -lt "$(num "$OPEN_ET")" ]; then
    log "pre-open, idling"
  elif [ "$eod_done" -eq 0 ] && [ "$e" -ge "$(num "$EOD_ET")" ]; then
    log "post-close, writing EOD snapshot"
    refresh eod
    eod_done=1
    log "EOD captured, ending session"
    break
  elif [ "$e" -gt "$(num "$LAST_ET")" ]; then
    log "past last refresh time, ending session"
    break
  else
    refresh intraday
  fi

  # Snap to the next interval boundary so timestamps stay on :00/:15/:30/:45
  # instead of drifting by the ~45s each refresh takes.
  now=$(date -u +%s)
  sleep $(( (now / INTERVAL_SEC + 1) * INTERVAL_SEC - now ))
done
