import type { NeedName } from "./objects.ts";

export const APTITUDE_IDS = [
  "intelligence", "memory", "perception", "creativity", "technical",
  "strength", "endurance", "agility", "dexterity", "reflexes",
  "charisma", "willpower", "resilience", "painTolerance",
] as const;
export type AptitudeId = typeof APTITUDE_IDS[number];
export type Aptitudes = Record<AptitudeId, number>;

export const APTITUDE_NAMES: Record<AptitudeId, string> = {
  intelligence: "Intelligence", memory: "Memory", perception: "Perception",
  creativity: "Creativity", technical: "Technical aptitude", strength: "Strength",
  endurance: "Endurance", agility: "Agility", dexterity: "Dexterity",
  reflexes: "Reflexes", charisma: "Charisma", willpower: "Willpower",
  resilience: "Emotional resilience", painTolerance: "Pain tolerance",
};

export const PERSONALITY_IDS = [
  "aggression", "impulsivity", "sociability", "empathy", "loyalty", "dominance",
  "courage", "deceit", "defiance", "curiosity", "conscientiousness", "volatility",
] as const;
export type PersonalityId = typeof PERSONALITY_IDS[number];
export type Personality = Record<PersonalityId, number>;

export const PERSONALITY_NAMES: Record<PersonalityId, [string, string]> = {
  aggression: ["Peaceable", "Aggressive"], impulsivity: ["Patient", "Impulsive"],
  sociability: ["Reserved", "Sociable"], empathy: ["Callous", "Empathetic"],
  loyalty: ["Opportunistic", "Loyal"], dominance: ["Yielding", "Dominant"],
  courage: ["Cautious", "Courageous"], deceit: ["Forthright", "Deceitful"],
  defiance: ["Conforming", "Defiant"], curiosity: ["Habitual", "Curious"],
  conscientiousness: ["Careless", "Conscientious"], volatility: ["Steady", "Volatile"],
};

export const SKILL_IDS = [
  "fighting", "athletics", "stealth", "digging", "toolcraft", "lockwork",
  "deception", "leadership", "smuggling", "electronics", "mechanics",
  "medicine", "cooking", "construction",
] as const;
export type SkillId = typeof SKILL_IDS[number];
export interface SkillProgress { level: number; xp: number }
export type Skills = Record<SkillId, SkillProgress>;
export const SKILL_NAMES: Record<SkillId, string> = {
  fighting: "Fighting", athletics: "Athletics", stealth: "Stealth", digging: "Digging",
  toolcraft: "Toolcraft", lockwork: "Lockwork", deception: "Deception",
  leadership: "Leadership", smuggling: "Smuggling", electronics: "Electronics",
  mechanics: "Mechanics", medicine: "Medicine", cooking: "Cooking",
  construction: "Construction",
};

export type CustodyClass = "minimum" | "medium" | "maximum" | "supermax";
export const CUSTODY_NAMES: Record<CustodyClass, string> = {
  minimum: "Minimum", medium: "Medium", maximum: "Maximum", supermax: "Supermax",
};
export const CUSTODY_COLORS: Record<CustodyClass, [number, number, number]> = {
  minimum: [0.72, 0.64, 0.43], medium: [0.92, 0.36, 0.07],
  maximum: [0.70, 0.10, 0.08], supermax: [0.31, 0.035, 0.075],
};

export type CrimeTag =
  | "property" | "financial" | "technical" | "organized" | "smuggling"
  | "violent" | "weapons" | "fire" | "vehicle" | "authority" | "escape";

export interface CrimeDef {
  id: string;
  name: string;
  severity: number;
  base: number;
  sentence: [number, number]; // months
  tags: CrimeTag[];
  skills: Partial<Record<SkillId, number>>;
  aptitude?: Partial<Record<AptitudeId, number>>;
  personality?: Partial<Record<PersonalityId, number>>;
}

const crime = (
  id: string, name: string, severity: number, base: number, sentence: [number, number],
  tags: CrimeTag[], skills: Partial<Record<SkillId, number>> = {},
  aptitude: Partial<Record<AptitudeId, number>> = {},
  personality: Partial<Record<PersonalityId, number>> = {},
): CrimeDef => ({ id, name, severity, base, sentence, tags, skills, aptitude, personality });

export const CRIME_DEFS: CrimeDef[] = [
  crime("petty-theft", "Petty theft", 1, 8, [6, 24], ["property"], { smuggling: 1 }, { dexterity: .12 }, { conscientiousness: -.12 }),
  crime("burglary", "Burglary", 2, 8, [18, 72], ["property"], { stealth: 2, lockwork: 2 }, { dexterity: .18, perception: .12 }, { impulsivity: -.08 }),
  crime("grand-theft", "Grand theft", 2, 6, [24, 84], ["property"], { stealth: 1, smuggling: 1 }, {}, { defiance: .1 }),
  crime("vehicle-theft", "Vehicle theft", 2, 5, [18, 72], ["property", "vehicle", "technical"], { mechanics: 2, lockwork: 1 }, { technical: .16 }, { courage: .08 }),
  crime("robbery", "Robbery", 3, 7, [36, 120], ["property", "violent"], { fighting: 2, deception: 1 }, { strength: .12 }, { aggression: .18, courage: .12 }),
  crime("vandalism", "Vandalism", 1, 4, [3, 18], ["property"], { toolcraft: 1 }, {}, { impulsivity: .18, defiance: .14 }),
  crime("fraud", "Fraud", 2, 6, [18, 96], ["financial"], { deception: 2 }, { intelligence: .15, memory: .08 }, { deceit: .22 }),
  crime("embezzlement", "Embezzlement", 3, 3, [36, 144], ["financial"], { deception: 2 }, { intelligence: .12 }, { conscientiousness: .1, deceit: .18 }),
  crime("counterfeiting", "Counterfeiting", 3, 3, [30, 120], ["financial", "technical"], { toolcraft: 2, deception: 1 }, { technical: .2, dexterity: .1 }, { conscientiousness: .1 }),
  crime("cybercrime", "Cybercrime", 3, 4, [24, 120], ["financial", "technical"], { electronics: 3, deception: 1 }, { intelligence: .22, technical: .22 }, { curiosity: .12 }),
  crime("bribery", "Bribery", 2, 2, [12, 60], ["financial", "authority"], { deception: 2, leadership: 1 }, { charisma: .12 }, { deceit: .16 }),
  crime("corruption", "Corruption", 3, 2, [30, 144], ["financial", "authority", "organized"], { deception: 2, leadership: 1 }, { intelligence: .1, charisma: .1 }, { deceit: .15, dominance: .1 }),
  crime("drug-trafficking", "Drug trafficking", 3, 8, [36, 144], ["smuggling", "organized"], { smuggling: 3, leadership: 1 }, {}, { courage: .08, deceit: .1 }),
  crime("smuggling", "Smuggling", 2, 5, [18, 84], ["smuggling"], { smuggling: 3, stealth: 1 }, { perception: .1 }, { deceit: .12 }),
  crime("weapons-trafficking", "Weapons trafficking", 4, 2, [60, 192], ["smuggling", "organized", "weapons"], { smuggling: 3, leadership: 1 }, {}, { courage: .12, dominance: .1 }),
  crime("prison-contraband", "Prison contraband", 2, 3, [12, 60], ["smuggling", "authority"], { smuggling: 3, stealth: 1 }, {}, { deceit: .12, defiance: .16 }),
  crime("racketeering", "Racketeering", 4, 3, [72, 240], ["organized", "violent"], { leadership: 3, deception: 2 }, { charisma: .15, intelligence: .1 }, { dominance: .2, deceit: .12 }),
  crime("extortion", "Extortion", 3, 3, [36, 144], ["organized", "violent"], { leadership: 2, fighting: 1 }, { charisma: .1, strength: .08 }, { dominance: .22, aggression: .12 }),
  crime("assault", "Assault", 3, 8, [18, 96], ["violent"], { fighting: 3 }, { strength: .15, reflexes: .08 }, { aggression: .28, volatility: .16 }),
  crime("armed-robbery", "Armed robbery", 4, 5, [60, 192], ["violent", "weapons", "property"], { fighting: 2, deception: 1 }, { reflexes: .1 }, { courage: .16, aggression: .16 }),
  crime("kidnapping", "Kidnapping", 5, 1, [96, 300], ["violent", "organized"], { leadership: 2, deception: 2 }, { intelligence: .08 }, { dominance: .18, empathy: -.2 }),
  crime("arson", "Arson", 4, 2, [48, 180], ["violent", "fire", "technical"], { toolcraft: 2, stealth: 1 }, { technical: .12 }, { defiance: .14, empathy: -.12 }),
  crime("manslaughter", "Manslaughter", 4, 3, [60, 180], ["violent"], { fighting: 1 }, {}, { impulsivity: .16 }),
  crime("attempted-homicide", "Attempted homicide", 5, 2, [96, 300], ["violent"], { fighting: 3 }, { strength: .1 }, { aggression: .22, courage: .1 }),
  crime("homicide", "Homicide", 5, 2, [144, 480], ["violent"], { fighting: 2 }, {}, { aggression: .16, empathy: -.12 }),
  crime("resisting-arrest", "Resisting arrest", 2, 4, [6, 36], ["authority"], { athletics: 1, fighting: 1 }, {}, { defiance: .2, courage: .1 }),
  crime("witness-intimidation", "Witness intimidation", 3, 2, [24, 120], ["authority", "organized"], { deception: 2, leadership: 1 }, { charisma: .08 }, { dominance: .18, deceit: .12 }),
  crime("escape", "Escape from custody", 4, 1, [36, 144], ["escape", "authority"], { stealth: 2, digging: 1, lockwork: 1 }, { agility: .1, creativity: .14 }, { defiance: .2, courage: .14 }),
  crime("evading-custody", "Evading custody", 2, 3, [6, 36], ["escape", "authority"], { stealth: 2, athletics: 1 }, { agility: .08 }, { defiance: .12 }),
];

export interface CrimeRecord {
  crimeId: string;
  ageAtConviction: number;
  sentenceMonths: number;
}

export interface PrisonerBody {
  height: number;
  build: number;
  skin: number;
  hairStyle: number;
  hairColor: number;
  scars: number;
  tattoos: number;
  posture: number;
  gesture: number;
}

export interface PrisonerProfile {
  seed: number;
  firstName: string;
  lastName: string;
  age: number;
  sentenceMonths: number;
  servedMonths: number;
  custody: CustodyClass;
  aptitudes: Aptitudes;
  personality: Personality;
  labels: string[];
  skills: Skills;
  conviction: CrimeRecord;
  priors: CrimeRecord[];
  body: PrisonerBody;
}

export interface PrisonerMind {
  stress: number;
  anger: number;
  confidence: number;
  fatigue: number;
  reputation: number;
  needWeights: Record<NeedName, number>;
}

class LocalRng {
  state: number;
  spare: number | null = null;
  constructor(seed: number) { this.state = (seed >>> 0) || 1; }
  next(): number {
    let x = this.state | 0;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x1_0000_0000;
  }
  normal(): number {
    if (this.spare !== null) { const v = this.spare; this.spare = null; return v; }
    const u = Math.max(1e-9, this.next()), v = this.next();
    const r = Math.sqrt(-2 * Math.log(u)), a = Math.PI * 2 * v;
    this.spare = r * Math.sin(a);
    return r * Math.cos(a);
  }
  int(n: number): number { return Math.floor(this.next() * n); }
}

const FIRST = [
  "Aaron", "Adam", "Adrian", "Andre", "Anton", "Ben", "Caleb", "Carlos", "Damon", "Daniel",
  "Darius", "David", "Diego", "Elias", "Emil", "Ethan", "Felix", "Gabriel", "Hassan", "Hector",
  "Isaac", "Ivan", "Jamal", "Javier", "Jonah", "Julian", "Kai", "Leon", "Liam", "Luca",
  "Malik", "Marco", "Marcus", "Mateo", "Micah", "Milan", "Nico", "Noah", "Omar", "Oscar",
  "Pavel", "Rafael", "Ramon", "Ravi", "Roman", "Samir", "Samuel", "Theo", "Tomas", "Victor",
];
const LAST = [
  "Adler", "Alvarez", "Baker", "Bennett", "Brooks", "Costa", "Cruz", "Dawson", "Diaz", "Doyle",
  "Fischer", "Flores", "Foster", "Garcia", "Grant", "Gray", "Haddad", "Hayes", "Hughes", "Ivanov",
  "Jackson", "Khan", "Kim", "Klein", "Kovac", "Lee", "Lewis", "Lopez", "Meyer", "Miller",
  "Morgan", "Nash", "Novak", "Ortiz", "Patel", "Pereira", "Petrov", "Price", "Reed", "Rivera",
  "Rossi", "Santos", "Silva", "Singh", "Taylor", "Turner", "Vega", "Walker", "Ward", "Young",
];

function clamp(v: number, lo = 0, hi = 1): number { return Math.max(lo, Math.min(hi, v)); }
function level(z: number): number { return Math.max(1, Math.min(10, Math.round(5.5 + z * 1.65))); }
function skillRecord(): Skills {
  return Object.fromEntries(SKILL_IDS.map((id) => [id, { level: 0, xp: 0 }])) as Skills;
}

function scoreCrime(def: CrimeDef, apt: Aptitudes, per: Personality, rng: LocalRng): number {
  let fit = 0;
  for (const [k, w] of Object.entries(def.aptitude ?? {}) as [AptitudeId, number][]) fit += ((apt[k] - 5.5) / 2.5) * w;
  for (const [k, w] of Object.entries(def.personality ?? {}) as [PersonalityId, number][]) fit += per[k] * w;
  const conditioned = def.base * Math.exp(fit * 2.1);
  return def.base * .15 + conditioned * .85 + rng.next() * .001;
}

function chooseWeighted<T>(rng: LocalRng, rows: T[], weight: (v: T) => number): T {
  const total = rows.reduce((s, r) => s + Math.max(0, weight(r)), 0);
  let n = rng.next() * total;
  for (const row of rows) { n -= Math.max(0, weight(row)); if (n <= 0) return row; }
  return rows[rows.length - 1];
}

function labelsFor(a: Aptitudes, p: Personality): string[] {
  const rows: [string, number][] = [
    ["Schemer", (a.intelligence + a.creativity) / 10 + p.deceit - p.impulsivity * .4],
    ["Hothead", p.aggression + p.impulsivity + p.volatility],
    ["Stoic", a.resilience / 5 - p.volatility - p.impulsivity * .3],
    ["Charmer", a.charisma / 5 + p.sociability + p.empathy * .3],
    ["Loner", -p.sociability + p.conscientiousness * .2],
    ["Loyalist", p.loyalty + p.empathy * .4],
    ["Opportunist", -p.loyalty + p.deceit * .5 + p.impulsivity * .2],
    ["Natural Leader", a.charisma / 5 + a.willpower / 10 + p.dominance + p.sociability * .3],
    ["Follower", -p.dominance + p.loyalty * .4],
    ["Peacemaker", p.empathy - p.aggression + a.charisma / 10],
    ["Daredevil", p.courage + p.impulsivity + a.agility / 10],
    ["Grudge-holder", p.aggression + p.conscientiousness - p.empathy],
    ["Meticulous", p.conscientiousness - p.impulsivity + a.memory / 10],
    ["Manipulator", p.deceit + a.charisma / 10 + a.intelligence / 10 - p.empathy * .3],
    ["Curious", p.curiosity + a.creativity / 10],
    ["Defiant", p.defiance + a.willpower / 10],
  ];
  rows.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]));
  const count = Math.max(2, Math.min(5, 2 + Math.floor(rows.filter((r) => r[1] > 1.6).length / 2)));
  const strong = rows.filter((r) => r[1] > .72).slice(0, count);
  for (const row of rows) if (strong.length < 2 && !strong.includes(row)) strong.push(row);
  return strong.slice(0, count).map((r) => r[0]);
}

export function generatePrisonerProfile(agentId: number, seed = Math.imul(agentId + 0x4f1bbcdc, 0x9e3779b1)): PrisonerProfile {
  const rng = new LocalRng(seed);
  const cognition = rng.normal(), physical = rng.normal(), coordination = rng.normal(), social = rng.normal(), grit = rng.normal();
  const independent = () => rng.normal();
  const a = {
    intelligence: level(cognition * .55 + independent() * .84),
    memory: level(cognition * .38 + independent() * .92),
    perception: level(cognition * .18 + coordination * .18 + independent() * .96),
    creativity: level(cognition * .28 + independent() * .96),
    technical: level(cognition * .32 + coordination * .18 + independent() * .91),
    strength: level(physical * .62 + independent() * .79),
    endurance: level(physical * .48 + grit * .18 + independent() * .86),
    agility: level(physical * .22 + coordination * .42 + independent() * .88),
    dexterity: level(coordination * .55 + cognition * .12 + independent() * .82),
    reflexes: level(coordination * .48 + independent() * .88),
    charisma: level(social * .62 + independent() * .79),
    willpower: level(grit * .58 + independent() * .81),
    resilience: level(grit * .52 + independent() * .85),
    painTolerance: level(grit * .3 + physical * .28 + independent() * .91),
  } satisfies Aptitudes;
  const facet = (shared: number, scale = .28) => clamp(shared * scale + rng.normal() * .48, -1, 1);
  const p = {
    aggression: facet(physical * .2 + grit * .1), impulsivity: facet(-grit * .2),
    sociability: facet(social * .7), empathy: facet(social * .25),
    loyalty: facet(grit * .2 + social * .12), dominance: facet(social * .35 + grit * .2),
    courage: facet(grit * .45 + physical * .15), deceit: facet(cognition * .18),
    defiance: facet(grit * .2), curiosity: facet(cognition * .35),
    conscientiousness: facet(grit * .38 + cognition * .12), volatility: facet(-grit * .35),
  } satisfies Personality;

  const current = chooseWeighted(rng, CRIME_DEFS, (d) => scoreCrime(d, a, p, rng));
  const age = 18 + rng.int(45);
  const priorCount = Math.min(4, Math.floor(rng.next() * rng.next() * Math.max(1, (age - 17) / 8)));
  const priors: CrimeRecord[] = [];
  for (let i = 0; i < priorCount; i++) {
    const d = chooseWeighted(rng, CRIME_DEFS, (row) => scoreCrime(row, a, p, rng) * (row.severity <= current.severity + 1 ? 1 : .35));
    priors.push({ crimeId: d.id, ageAtConviction: Math.max(18, age - 2 - rng.int(Math.max(1, age - 19))), sentenceMonths: d.sentence[0] + rng.int(d.sentence[1] - d.sentence[0] + 1) });
  }
  const sentenceMonths = current.sentence[0] + rng.int(current.sentence[1] - current.sentence[0] + 1);
  const conviction = { crimeId: current.id, ageAtConviction: age - rng.int(Math.min(6, age - 17)), sentenceMonths };
  const skills = skillRecord();
  for (const record of [conviction, ...priors]) {
    const d = crimeDef(record.crimeId);
    for (const [id, gain] of Object.entries(d?.skills ?? {}) as [SkillId, number][]) {
      skills[id].level = Math.min(10, skills[id].level + gain);
    }
  }
  const violentPriors = priors.filter((r) => crimeDef(r.crimeId)?.tags.includes("violent")).length;
  const priorEscape = priors.some((r) => crimeDef(r.crimeId)?.tags.includes("escape"));
  const organized = current.tags.includes("organized") && skills.leadership.level >= 2;
  const custodyScore = current.severity + (violentPriors > 0 ? 1 : 0) + (priorEscape ? 1 : 0) + (organized ? 1 : 0);
  const custody: CustodyClass = custodyScore <= 2 ? "minimum" : custodyScore <= 4 ? "medium" : custodyScore <= 6 ? "maximum" : "supermax";
  const height = clamp(.9 + rng.normal() * .055 + (a.strength - 5.5) * .004, .78, 1.12);
  const build = clamp(.85 + (a.strength - 5.5) * .045 + (a.endurance - 5.5) * .015 + rng.normal() * .07, .7, 1.18);
  return {
    seed: seed >>> 0, firstName: FIRST[rng.int(FIRST.length)], lastName: LAST[rng.int(LAST.length)], age,
    sentenceMonths, servedMonths: rng.int(Math.max(1, Math.min(sentenceMonths, 48))), custody,
    aptitudes: a, personality: p, labels: labelsFor(a, p), skills, conviction, priors,
    body: {
      height, build, skin: rng.next(), hairStyle: rng.int(6), hairColor: rng.next(),
      scars: rng.next() < .14 + violentPriors * .12 ? 1 + rng.int(2) : 0,
      tattoos: rng.next() < .32 ? 1 + rng.int(3) : 0,
      posture: clamp((p.dominance + p.courage - p.volatility * .3) * .35, -.8, .8),
      gesture: rng.int(4),
    },
  };
}

export function freshPrisonerMind(profile: PrisonerProfile): PrisonerMind {
  const p = profile.personality;
  const dependencyRoll = (salt: number) => (((profile.seed ^ (salt * 0x9e3779b9)) >>> 0) % 1000) / 1000;
  const tobacco = dependencyRoll(11) < .22 ? 1 + dependencyRoll(12) * .45 : 0;
  const alcohol = dependencyRoll(21) < .12 ? 1 + dependencyRoll(22) * .55 : 0;
  const drugs = dependencyRoll(31) < .075 ? 1.1 + dependencyRoll(32) * .65 : 0;
  return {
    stress: .08, anger: Math.max(0, p.aggression * .08), confidence: clamp(.5 + p.courage * .2),
    fatigue: 0, reputation: clamp((profile.skills.leadership.level + profile.skills.fighting.level) / 20 + p.dominance * .12),
    needWeights: {
      food: 1, sleep: 1, outdoors: 1 + p.curiosity * .12, comfort: 1 + p.conscientiousness * .1,
      hygiene: 1 + p.conscientiousness * .25, recreation: 1 + p.curiosity * .3,
      exercise: 1 + (profile.aptitudes.strength + profile.aptitudes.endurance - 11) * .035,
      bladder: 1, spirituality: 1, social: clamp(1 + p.sociability * .55, .35, 1.65),
      family: clamp(1 + p.loyalty * .25 + p.empathy * .12, .55, 1.5),
      safety: clamp(1 - p.courage * .22 - profile.aptitudes.resilience * .018, .55, 1.5),
      privacy: clamp(1 - p.sociability * .35 + p.conscientiousness * .12, .45, 1.65),
      tobacco, alcohol, drugs,
    },
  };
}

export function crimeDef(id: string): CrimeDef | undefined { return CRIME_DEFS.find((d) => d.id === id); }
export function crimeName(id: string): string { return crimeDef(id)?.name ?? id; }
export function aptitude(profile: PrisonerProfile | null, id: AptitudeId, fallback = 5): number {
  return profile?.aptitudes[id] ?? fallback;
}
export function personality(profile: PrisonerProfile | null, id: PersonalityId): number {
  return profile?.personality[id] ?? 0;
}
export function skill(profile: PrisonerProfile | null, id: SkillId): number {
  return profile?.skills[id].level ?? 0;
}

export function gainSkill(profile: PrisonerProfile | null, id: SkillId, xp: number): void {
  if (!profile || xp <= 0) return;
  const s = profile.skills[id];
  if (s.level >= 10) return;
  s.xp += xp;
  while (s.level < 10 && s.xp >= 100 + s.level * 35) {
    s.xp -= 100 + s.level * 35;
    s.level++;
  }
}
