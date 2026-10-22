"""Terminal presentation only; no training, selection or qualification decisions."""
from __future__ import annotations

import json
import shlex

PHASES = {
    "not-started": "не е започнат", "collect": "събиране на учителски примери",
    "pretrain": "начално обучение", "train": "самоигра", "validation": "предварителна проверка",
    "primary": "независима проверка срещу трудните ботове", "crossplay": "проверка със среден партньор",
    "champion": "сравнение с активния модел", "ready": "квалификацията е завършена",
}
REASONS = {
    "validation-not-better": "няма по-добър предварителен резултат от досегашния най-добър кандидат",
    "validation-no-possible-advantage": "дори всички оставащи мачове да са победи, резултатът не може да надвиши 50%",
    "validation-no-advantage": "победите в предварителната проверка не надвишават 50%",
    "final-no-proven-advantage": "независимата проверка не доказва предимство",
    "decision-budget-exceeded": "времето за избор надвишава разрешения бюджет",
    "no-proven-advantage-over-active": "няма доказано предимство над активния модел",
    "manually-activated": "включен е ръчно",
}


def event_output(event, json_output=False):
    if json_output:
        print(json.dumps(event), flush=True)
        return
    kind = event["event"]
    phase = PHASES.get(event.get("phase"), event.get("phase", ""))
    if kind == "cycle-start":
        limit = f'{event["games"]} завършени мача' if event.get("games") is not None else f'{event["minutes"]:g} минути'
        line = f'Сесия: до {limit}. Записите се запазват за следващо продължаване.'
    elif kind == "cycle-phase":
        remaining = f'{event["gamesRemaining"]} мача' if event.get("gamesRemaining") is not None else f'{event["minutesRemaining"]:g} мин.'
        line = f'Фаза: {phase}. Оставащ бюджет: {remaining}'
    elif kind.startswith("evaluation-"):
        label = {"evaluation-start": "Начало/продължаване", "evaluation-progress": "Напредък",
                 "evaluation-paused": "Сесията спря; проверката е записана за продължаване",
                 "evaluation-complete": "Проверката е завършена",
                 "evaluation-rejected": "Кандидатът е отхвърлен предсрочно: над 50% победи вече са невъзможни"}[kind]
        games, wins = event["games"], event["wins"]
        rate = f"{wins / games:.1%}" if games else "няма завършени мачове"
        line = (f'{label}: {phase}; {games}/{event["gamesRequested"]} мача, '
                f'{event["completedSeeds"]}/{event["seedsRequested"]} семена; '
                f'победи {wins:g}/{games} ({rate}); модел {event["model"]}.')
    elif kind == "training-progress":
        line = (f'Обучение ({phase}): {event.get("collectSteps", 0)} учителски примера; '
                f'{event.get("pretrainUpdates", 0)} начални стъпки; '
                f'{event.get("matches", 0)} завършени тренировъчни мача; '
                f'{event.get("rlUpdates", 0)} стъпки от самоигра.')
    elif kind == "candidate-rejected":
        line = f'Кандидат {event["model"][:12]} е отхвърлен: {REASONS.get(event["reason"], event["reason"])}.'
    else:
        line = json.dumps(event, ensure_ascii=False)
    print(line, flush=True)


def next_step(state):
    run = shlex.quote(state["run"])
    if state["readyForActivation"]:
        registry = state.get("thresholds", {}).get("registry")
        suffix = f" --registry {shlex.quote(registry)}" if registry else ""
        return {"description": "Кандидатът е квалифициран. Може да бъде включен ръчно за новите мачове.",
                "command": f'npm run bots:learn -- activate --model {shlex.quote(state["candidate"]["path"])}{suffix}'}
    phase = state["phase"]
    if phase in ["validation", "primary", "crossplay", "champion"]:
        description = "Продължи проверката на същия кандидат. През тази фаза теглата не се обучават."
    elif phase == "train":
        target = state.get("nextTrainingMatch")
        description = f"Продължи самоиграта до общо {target} завършени тренировъчни мача; после цикълът оценява нов кандидат."
    elif phase == "ready":
        description = "Продължи цикъла, за да провери съвместимостта с активната версия."
    else:
        description = "Продължи подготовката и обучението на същия експеримент."
    return {"description": description, "command": f"npm run bots:learn -- cycle --run {run} --games 20"}


def print_status(state, json_output=False):
    if json_output:
        print(json.dumps(state), flush=True)
        return
    print(f'\nЕксперимент: {state["run"]}')
    print(f'Фаза: {PHASES.get(state["phase"], state["phase"])}.')
    metrics, thresholds = state["metrics"], state.get("thresholds") or {}
    print(f'Обучение: {metrics.get("collectSteps", 0)}/{thresholds.get("teacher_examples", "?")} учителски примера; '
          f'{metrics.get("pretrainUpdates", 0)}/{thresholds.get("pretrain_steps", "?")} начални стъпки; '
          f'{metrics.get("matches", 0)} тренировъчни мача.')
    candidate = state.get("candidate")
    if candidate:
        print(f'Кандидат: {candidate["id"][:12]}')
    for name, report in state["reports"].items():
        games = report.get("games", 0)
        requested = (report.get("seedsRequested") or 0) * 4
        completion = "ОТХВЪРЛЕНА ПРЕДСРОЧНО" if report.get("earlyRejected") else "завършена" if report.get("complete") else "НЕЗАВЪРШЕНА"
        print(f'{PHASES.get(name, name).capitalize()}: {games}/{requested} мача — {completion}.')
        if report.get("wins") is not None:
            wins = report["wins"]
            rate = f'{wins / games:.1%}' if games else 'няма резултат'
            print(f'  Победи: {wins:g}/{games} ({rate}).')
        ci = report.get("confidence") or {}
        if report.get("completedSeeds") and ci:
            print(f'  Завършени семена: {report["completedSeeds"]}/{report["seedsRequested"]}; '
                  f'победи в тях: {ci["mean"]:.1%}; 95% интервал: {ci["lower"]:.1%}–{ci["upper"]:.1%}.')
        scenarios = report.get("scenarios") or {}
        cases = scenarios.get("cases", [])
        if cases:
            print(f'  Тактически ситуации: {sum(bool(c["success"]) for c in cases)}/{len(cases)}; диагностичен резултат.')
    outcome = state.get("lastOutcome")
    if outcome:
        reason = outcome["reason"]
        label = "Последно включване" if reason == "manually-activated" else "Последен отхвърлен кандидат"
        print(f'{label}: {outcome["id"][:12]} — {REASONS.get(reason, reason)}.')
        for name, report in outcome.get("reports", {}).items():
            ci = report.get("confidence") or {}
            games, wins = report.get("games", 0), report.get("wins")
            if wins is not None and games:
                print(f'  {PHASES.get(name, name)}: {games} мача; победи {wins:g}/{games} ({wins/games:.1%}).')
            elif ci:
                print(f'  {PHASES.get(name, name)}: {games} мача; победи в завършените семена {ci["mean"]:.1%}.')
            rejection = report.get("earlyRejection")
            if rejection:
                print(f'  Максимално възможен краен резултат: {rejection["maxPossibleWinRate"]:.1%}.')
    print('Готов за активиране: ' + ('ДА.' if state["readyForActivation"] else 'НЕ.'))
    print('Активен модел: ' + (state["active"].get("current") or 'сегашният труден бот') + '.')
    step = state.get("nextStep") or next_step(state)
    budget = state.get("sessionBudget")
    if budget and budget.get("gamesRequested") is not None:
        print(f'Тази сесия: {budget["gamesCompleted"]}/{budget["gamesRequested"]} завършени мача общо.')
    print('Следваща стъпка: ' + step["description"])
    print(step["command"], flush=True)
