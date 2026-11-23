export type ChallengeOpportunitySource = {
  id: string;
  label: string;
  url: string;
};

/**
 * Challenge intent review: the exact review shown before a stake is signed.
 * A review is bound to the account, stake amount (integer USDC base units),
 * claim statement revision and network it was produced for. Any change to
 * those inputs invalidates the review, so a stale review can never authorize
 * a different stake.
 */
export type ChallengeIntentReview = {
  account: string;
  stakeUsdc: bigint;
  claimStatement: string;
  claimRevision: number;
  network: string;
};

export type ChallengeIntentReviewInput = {
  account: string;
  stakeUsdc: bigint;
  claimStatement: string;
  claimRevision: number;
  network: string;
};

export function createChallengeIntentReview(
  input: ChallengeIntentReviewInput,
): ChallengeIntentReview {
  return { ...input };
}

export function isChallengeIntentReviewCurrent(
  review: ChallengeIntentReview | null,
  current: ChallengeIntentReviewInput,
): boolean {
  if (!review) return false;
  return (
    review.account === current.account &&
    review.stakeUsdc === current.stakeUsdc &&
    review.claimStatement === current.claimStatement &&
    review.claimRevision === current.claimRevision &&
    review.network === current.network
  );
}

export const CHALLENGE_OPPORTUNITY_SOURCES: ChallengeOpportunitySource[] = [
  {
    id: "football-fixtures",
    label: "BBC Sport football fixtures",
    url: "https://www.bbc.com/sport/football/scores-fixtures",
  },
  {
    id: "formula1-calendar",
    label: "Formula 1 2026 calendar",
    url: "https://www.formula1.com/en/racing/2026",
  },
  {
    id: "buenos-aires-weather",
    label: "Buenos Aires weather forecast",
    url: "https://weather.com/weather/tenday/l/Buenos+Aires+Distrito+Federal+Argentina",
  },
  {
    id: "bitcoin-price",
    label: "CoinGecko Bitcoin page",
    url: "https://www.coingecko.com/en/coins/bitcoin",
  },
  {
    id: "ethereum-price",
    label: "CoinMarketCap Ethereum page",
    url: "https://coinmarketcap.com/currencies/ethereum/",
  },
  {
    id: "nvidia-investor-events",
    label: "NVIDIA investor events",
    url: "https://investor.nvidia.com/events-and-presentations/default.aspx",
  },
  {
    id: "apple-investor",
    label: "Apple investor relations",
    url: "https://investor.apple.com/investor-relations/default.aspx",
  },
  {
    id: "openai-news",
    label: "OpenAI news",
    url: "https://openai.com/news/",
  },
  {
    id: "google-blog",
    label: "Google blog",
    url: "https://blog.google/",
  },
  {
    id: "grammys",
    label: "GRAMMY awards",
    url: "https://www.grammy.com/awards",
  },
];
