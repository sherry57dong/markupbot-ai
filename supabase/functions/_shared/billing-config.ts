export interface PlanConfig {
  credits: number;
  bucket: "subscription" | "addon";
  name: string;
}

// price_id → plan info. Add new prices here; never remove old ones (historic webhooks).
export const PRICE_CONFIG: Record<string, PlanConfig> = {
  // ── Test mode ─────────────────────────────────────────────────────────────
  "price_1U3UgBLxIo85N3edufhbrw1z": { credits: 50,   bucket: "subscription", name: "Starter Monthly" },
  "price_1U3eBHLxIo85N3edLkQZlm4X": { credits: 50,   bucket: "subscription", name: "Starter Annual"  },
  "price_1U3UgCLxIo85N3edA2xah0dR": { credits: 300,  bucket: "subscription", name: "Agency Monthly"  },
  "price_1U3eBHLxIo85N3edVuKj5dTh": { credits: 300,  bucket: "subscription", name: "Agency Annual"   },
  "price_1U3UgCLxIo85N3ed7jYsJkfn": { credits: 1500, bucket: "subscription", name: "Studio Monthly"  },
  "price_1U3eBHLxIo85N3edxkrLPBWX": { credits: 1500, bucket: "subscription", name: "Studio Annual"   },
  "price_1U3UgCLxIo85N3ed7oA4IDFI": { credits: 50,   bucket: "addon",        name: "Credit Pack"     },

  // ── Live mode ─────────────────────────────────────────────────────────────
  "price_1U3Ps7LxIo85N3edggDLlQjX": { credits: 50,   bucket: "subscription", name: "Starter Monthly" },
  "price_1U3Pw6LxIo85N3eduAf2iwUu": { credits: 50,   bucket: "subscription", name: "Starter Annual"  },
  "price_1U3Py2LxIo85N3edxgXZXUXx": { credits: 300,  bucket: "subscription", name: "Agency Monthly"  },
  "price_1U3PyeLxIo85N3edSQ1elb5A": { credits: 300,  bucket: "subscription", name: "Agency Annual"   },
  "price_1U3Q01LxIo85N3edsbLnj02J": { credits: 1500, bucket: "subscription", name: "Studio Monthly"  },
  "price_1U3Q0SLxIo85N3edcCyMxgS5": { credits: 1500, bucket: "subscription", name: "Studio Annual"   },
  "price_1U3Q1qLxIo85N3edxdh1h2wT": { credits: 50,   bucket: "addon",        name: "Credit Pack"     },
};
