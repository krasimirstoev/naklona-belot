import { deck, legalCards, strength, suit, team, winner } from './engine.js';
import { SUITS, type Card, type Play, type Suit, type View } from './types.js';

/** Deliberately excludes other hands, the stock and server state. */
export type BotPosition = Pick<View, 'hand' | 'seat' | 'counts' | 'contract' | 'declarer' |
  'trick' | 'tricks' | 'announcements' | 'belots'>;
export interface BotKnowledge {
  played: Card[];
  remaining: Card[];
  unknown: Card[];
  possibleOwners: Partial<Record<Card, number[]>>;
  voidSuits: Suit[][];
  remainingTrumps: Card[];
  highestRemaining: Partial<Record<Suit, Card>>;
  masters: Card[];
  declaringTeam: number | null;
  currentWinner: number | null;
  assumptions: { id: 'declarer-length'; player: number; description: string }[];
}

export function buildKnowledge(v: BotPosition): BotKnowledge {
  const contract = v.contract!;
  const played = [...v.tricks.flatMap(t => t.plays), ...v.trick].map(p => p.card);
  const playedSet = new Set(played), own = new Set(v.hand);
  const remaining = deck().filter(c => !playedSet.has(c));
  const unknown = remaining.filter(c => !own.has(c));
  const events: { play: Play; prior: Play[] }[] = [];
  const voidSuits: Suit[][] = [[], [], [], []];
  for (const plays of [...v.tricks.map(t => t.plays), v.trick]) {
    plays.forEach((play, i) => {
      events.push({ play, prior: plays.slice(0, i) });
      if (i && suit(play.card) !== suit(plays[0].card) && !voidSuits[play.player].includes(suit(plays[0].card))) {
        voidSuits[play.player].push(suit(plays[0].card));
      }
    });
  }
  const possibleOwners: BotKnowledge['possibleOwners'] = {};
  for (const c of remaining) {
    if (own.has(c)) { possibleOwners[c] = [v.seat]; continue; }
    possibleOwners[c] = [0, 1, 2, 3].filter(p => p !== v.seat && v.counts[p] > 0 &&
      v.announcements.every(a => !a.cards.includes(c) || a.player === p) &&
      v.belots.every(b => suit(c) !== b.suit || !['K', 'Q'].includes(c.split('-')[1]) || b.player === p) &&
      events.every(e => e.play.player !== p || legalCards([e.play.card, c], e.prior, contract, p).includes(e.play.card)));
  }
  for (let p = 0; p < 4; p++) for (const s of SUITS) {
    if (!remaining.some(c => suit(c) === s && possibleOwners[c]?.includes(p)) && !voidSuits[p].includes(s)) voidSuits[p].push(s);
  }
  const highestRemaining: BotKnowledge['highestRemaining'] = {};
  for (const s of SUITS) highestRemaining[s] = remaining.filter(c => suit(c) === s)
    .sort((a, b) => strength(b, contract) - strength(a, contract))[0];
  return {
    played, remaining, unknown, possibleOwners, voidSuits,
    remainingTrumps: contract === 'NT' ? [] : remaining.filter(c => contract === 'AT' || suit(c) === contract),
    highestRemaining,
    masters: v.hand.filter(c => !unknown.some(other => suit(other) === suit(c) && strength(other, contract) > strength(c, contract))),
    declaringTeam: v.declarer === null ? null : team(v.declarer),
    currentWinner: v.trick.length ? winner(v.trick, contract) : null,
    assumptions: v.declarer === null || contract === 'NT' || contract === 'AT' ? [] : [{
      id: 'declarer-length', player: v.declarer, description: 'Обявилият вероятно има дължина в коза; това не е ограничение за разпределянето.'
    }]
  };
}
