import { select } from "@xazzzi/gg";

export type Values = {
  name: string;
  bio: string;
  age: number;
  volume: number;
  color: string;
  date: string;
  plan: string;
  country: string;
  features: string[];
  languages: string[];
  newsletter: boolean;
};

export const PLANS = ["free", "pro", "team"],
  COUNTRIES = ["Japan", "Kenya", "Norway", "Peru", "Vietnam"],
  FEATURES = ["dark mode", "beta", "sync"],
  LANGUAGES = ["TypeScript", "Rust", "Go", "Elixir", "Zig"];

const DEFAULTS: Values = {
  name: "Ada",
  bio: "Writes notes on engines.",
  age: 36,
  volume: 40,
  color: "#3d8bfd",
  date: "1843-07-10",
  plan: "pro",
  country: "Norway",
  features: ["sync"],
  languages: ["TypeScript"],
  newsletter: true,
};

// Plain values only, so autoClose would close the form after its first snapshot.
export const form = select({ ...DEFAULTS }, { autoClose: false });

const pick = <T>(list: readonly T[]) =>
  list[Math.floor(Math.random() * list.length)];
const some = <T>(list: readonly T[]) => list.filter(() => Math.random() < 0.5);
const int = (min: number, max: number) =>
  min + Math.floor(Math.random() * (max - min + 1));
const pad = (n: number) => `${n}`.padStart(2, "0");

// Object.assign writes key by key, and select publishes one snapshot for all of them.
export const reset = () => Object.assign(form, DEFAULTS);
export const randomize = () =>
  Object.assign(form, {
    name: pick(["Grace", "Alan", "Barbara", "Edsger", "Radia"]),
    bio: pick(["", "Likes queues.", "Proves things.", "Ships compilers."]),
    age: int(18, 90),
    volume: int(0, 100),
    color: `#${int(0, 0xffffff).toString(16).padStart(6, "0")}`,
    date: `${int(1900, 2030)}-${pad(int(1, 12))}-${pad(int(1, 28))}`,
    plan: pick(PLANS),
    country: pick(COUNTRIES),
    features: some(FEATURES),
    languages: some(LANGUAGES),
    newsletter: Math.random() < 0.5,
  });
