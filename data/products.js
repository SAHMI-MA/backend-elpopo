
module.exports = [
  {
    id: 'playbook',
    name: 'The ELPOPO Digital Playbook',
    description: '6-module video curriculum + objection scripts + VPG worksheets.',
    amountCents: 19900,
    currency: 'usd',
    image: '',
    video: '',
    category: 'digital',
  },
  {
    id: 'coaching',
    name: '8-Week 1-on-1 Coaching Program',
    description: 'Live, personalised coaching built around your floor, your numbers, your gaps.',
    amountCents: 199700,
    currency: 'usd',
    image: '',
    video: '',
    category: 'coaching',
  },
  {
    id: 'seminar',
    name: '2-Day Intensive Seminar - Sept 19 - Las Vegas',
    description: 'Two days in the room: live demos, hot seats, roleplay battles.',
    amountCents: 79700,
    currency: 'usd',
    image: '',
    video: '',
    category: 'event',
  },
  {
    id: 'summit',
    name: '3-Day Elite Summit - Nov 7 - Orlando',
    description: 'Three days, full faculty, guest legends, the ELPOPO Gauntlet.',
    amountCents: 149700,
    currency: 'usd',
    image: '',
    video: '',
    category: 'event',
  },
  {
    id: 'vip',
    name: 'VIP Day - The Golden Circle - Jan 23 - Scottsdale',
    description: 'Private day for 10 reps maximum. Your presentation rebuilt live.',
    amountCents: 499700,
    currency: 'usd',
    image: '',
    video: '',
    category: 'vip',
    applyOnly: true,
  },
];

// Helper exports for routes.
module.exports.byId = function byId(id) {
  return module.exports.find((p) => p.id === id) || null;
};
