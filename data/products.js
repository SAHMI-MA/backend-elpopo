const products = [
  {
    id: 'frame-game',
    name: 'The Frame Game',
    description: '',
    amountCents: 4700,
    currency: 'usd',
    category: 'digital',
  },
  {
    id: '7-layer-blueprint',
    name: '7-Layer Blueprint',
    description: '',
    amountCents: 9700,
    currency: 'usd',
    category: 'digital',
  },
  {
    id: 'objection-reframe-playbook',
    name: 'Objection Reframe Playbook',
    description: '',
    amountCents: 4700,
    currency: 'usd',
    category: 'digital',
  },
  {
    id: 'elite-closer-identity-workbook',
    name: 'Elite Closer Identity Workbook',
    description: '',
    amountCents: 2700,
    currency: 'usd',
    category: 'digital',
  },
  {
    id: 'closers-code',
    name: 'The Closer’s Code',
    description: '',
    amountCents: 6700,
    currency: 'usd',
    category: 'digital',
  },
  {
    id: 'closing-diagnosis',
    name: 'Private 1-Hour Closing Diagnosis With Tarik',
    description: '',
    amountCents: 49700,
    currency: 'usd',
    category: 'coaching',
  },
];

module.exports = {
  list: products,
  byId(id) {
    return products.find((p) => p.id === id);
  },
};
