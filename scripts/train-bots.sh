#!/usr/bin/env bash
# The resumable controller handles collection, pretraining, self-play and qualification.
set -euo pipefail
project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd -- "$project_root"
training_python="${BELOT_TRAINING_PYTHON:-$project_root/.venv-training/bin/python}"
if [[ ! -x "$training_python" ]]; then
  echo 'Липсва Python средата за обучение. Следвайте docs/bot-learning.md за подготовката.' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'Необходим е Node от проекта.' >&2
  exit 1
fi
has_run=false
for argument in "$@"; do
  case "$argument" in --run|--run=*) has_run=true ;; esac
done
if [[ "$has_run" == false ]]; then
  set -- --run data/quality/strategy-v2-1 "$@"
fi
# exec preserves terminal signals: Ctrl+C checkpoints the Python session.
# Activation is deliberately a separate command after successful qualification.
exec "$training_python" training/learn.py cycle "$@"
