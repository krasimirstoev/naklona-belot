export const SUITS = ['C', 'D', 'H', 'S'] as const;
export const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const;
export const CONTRACTS = [...SUITS, 'NT', 'AT'] as const;
export type Suit = typeof SUITS[number];
export type Rank = typeof RANKS[number];
export type Card = `${Suit}-${Rank}`;
export type Contract = typeof CONTRACTS[number];
export type Difficulty = 'easy' | 'medium' | 'hard';
export type Speed = 'slow' | 'normal' | 'fast';
export interface Settings { speed: Speed; revision: number }
export const SPEED_LABEL: Record<Speed,string> = {slow:'Бавна',normal:'Нормална',fast:'Бърза'};
export interface AnnouncementEvent {
  id: number; round: number; revision: number; player: number;
  kind: 'bid' | 'declaration' | 'belot'; text: string; bid?: Bid;
}
export type Phase = 'bidding' | 'playing' | 'trick' | 'roundEnd' | 'matchEnd';
export type Bid = Contract | 'pass' | 'contra' | 'recontra';
export interface Play { player: number; card: Card }
export interface Trick { plays: Play[]; winner: number }
export interface Declaration { id: string; kind: 'sequence' | 'four'; value: number; strength: number; label: string; cards: Card[] }
export interface Announced extends Declaration { player: number }
export interface Call { player: number; bid: Bid }
export interface RoundResult {
  number: number; contract: Contract; declarer: number; multiplier: number;
  cardPoints: number[]; declarationPoints: number[]; belotPoints: number[];
  raw: number[]; added: number[]; total: number[]; hanging: number;
  outcome: 'made' | 'failed' | 'hanging'; capot: boolean;
}
export interface Game {
  /** Immutable model for this match; null/absent means the original hard policy. Never exposed in View. */
  botModelId?: string | null;
  events: AnnouncementEvent[]; eventSeq: number;
  id: string; revision: number; difficulty: Difficulty; phase: Phase; dealer: number; turn: number; round: number;
  hands: Card[][]; stock: Card[]; contract: Contract | null; declarer: number | null; multiplier: number;
  passes: number; calls: Call[]; trick: Play[]; tricks: Trick[]; announcements: Announced[];
  belots: {player: number; suit: Suit}[]; scores: number[]; hanging: number; results: RoundResult[];
  message: string;
}
export type Action = {type: 'bid'; bid: Bid} | {type: 'play'; card: Card; declare?: string[]; belot?: boolean} | {type: 'collect'} | {type: 'next'};
export interface View {
  events: AnnouncementEvent[];
  id: string; revision: number; difficulty: Difficulty; phase: Phase; dealer: number; turn: number; round: number;
  hand: Card[]; counts: number[]; contract: Contract | null; declarer: number | null; multiplier: number;
  calls: Call[]; trick: Play[]; tricks: Trick[]; announcements: Announced[];
  belots: {player: number; suit: Suit}[]; scores: number[]; hanging: number; results: RoundResult[]; message: string;
  legalCards: Card[]; legalBids: Bid[]; declarations: Declaration[]; belotCards: Card[]; seat: number;
}
export const SYMBOL: Record<Suit, string> = { C:'♣', D:'♦', H:'♥', S:'♠' };
export const CONTRACT_LABEL: Record<Contract, string> = { C:'Спатия', D:'Каро', H:'Купа', S:'Пика', NT:'Без коз', AT:'Всичко коз' };
export const BID_LABEL: Record<Bid,string> = {...CONTRACT_LABEL,pass:'Пас',contra:'Контра',recontra:'Реконтра'};
export const NAMES = ['Ти', 'Никола', 'Борис', 'Виктор'];
export const DIFFICULTY_LABEL = {easy:'Лесна',medium:'Средна',hard:'Трудна'};

export interface StateResponse { game: View | null; settings: Settings }
