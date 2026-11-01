// Facts about Cedar Lane Auto Detailing. The booking rules read services,
// hours, slots and bays from here, and the system prompt is built from the
// rest, so the agent and the code never disagree.

export type Service = {
  id: string;
  name: string;
  durationMinutes: number;
  // null means the price needs a custom quote, so a human handles it.
  priceUsd: number | null;
};

// "HH:MM" in the shop's timezone, or null when closed.
export type DayHours = { open: string; close: string } | null;

export type ShopConfig = {
  name: string;
  // IANA timezone. All dates and times the agent sees are in this zone.
  timezone: string;
  // Indexed by day of the week: 0 is Sunday, 6 is Saturday.
  hours: readonly DayHours[];
  slotMinutes: number;
  // How many appointments can run at the same time.
  bays: number;
  services: readonly Service[];
  vehicles: {
    accepted: readonly string[];
    declined: readonly string[];
    largeVehicleSurchargeUsd: number;
    largeVehicles: readonly string[];
  };
  policies: {
    prep: string;
    lateGraceMinutes: number;
    cancellation: string;
    payment: string;
  };
  // Things the agent never handles itself; it logs them for a human.
  handoffReasons: readonly string[];
  // Answers to other common questions. The agent answers only what's here
  // and in the fields above; for anything else it says it doesn't know and
  // offers a callback. To teach it a new answer, add an entry.
  faq: readonly { question: string; answer: string }[];
};

const weekday: DayHours = { open: '09:00', close: '18:00' };

export const shop: ShopConfig = {
  name: 'Cedar Lane Auto Detailing',
  timezone: 'America/Los_Angeles',
  hours: [null, weekday, weekday, weekday, weekday, weekday, weekday],
  slotMinutes: 30,
  bays: 1,
  services: [
    { id: 'exterior-wash', name: 'Exterior wash', durationMinutes: 30, priceUsd: 40 },
    { id: 'interior-detail-wash', name: 'Interior detail & wash', durationMinutes: 60, priceUsd: 120 },
    { id: 'full-detail', name: 'Full detail (interior + exterior)', durationMinutes: 180, priceUsd: 250 },
    { id: 'paint-correction', name: 'Paint correction / ceramic coating', durationMinutes: 480, priceUsd: null },
  ],
  vehicles: {
    accepted: ['sedans', 'coupes', 'hatchbacks', 'SUVs', 'pickup trucks', 'minivans'],
    declined: ['RVs', 'boats', 'motorcycles', 'commercial trucks'],
    largeVehicleSurchargeUsd: 20,
    largeVehicles: ['SUVs', 'pickup trucks', 'minivans'],
  },
  policies: {
    prep: 'Remove personal items and valuables. Let us know about pet hair or heavy stains, since those can cost extra.',
    lateGraceMinutes: 15,
    cancellation: 'Please give at least 24 hours notice to cancel or reschedule.',
    payment: 'Card or cash at pickup.',
  },
  handoffReasons: [
    'complaints about a charge',
    'refunds',
    'damage claims',
    'custom quotes, such as ceramic coating or fleet pricing',
    "anything you're not sure about",
  ],
  faq: [
    { question: 'Do you come to my home or office (mobile detailing)?', answer: 'No, all work is done at the shop.' },
    {
      question: 'Can I wait while my car is done?',
      answer: 'Yes, there is a small waiting area with Wi-Fi and coffee.',
    },
    { question: 'Do you sell gift cards?', answer: 'Yes, in any amount, at the front desk.' },
  ],
};
