// slash command definitions

const STRING = 3;

export const COMMANDS = [
  {
    name: 'define',
    description: 'Look up a Tlag word, or search by English meaning',
    options: [{
      type: STRING,
      name: 'word',
      description: 'A Tlag word or an English meaning',
      required: true,
      autocomplete: true,
      max_length: 100,
    }],
  },
  {
    name: 'random',
    description: 'Show a random Tlag word',
    options: [{
      type: STRING,
      name: 'category',
      description: 'Only pick from this category (food and drink, anatomy, ...)',
      required: false,
      autocomplete: true,
      max_length: 100,
    }],
  },
  {
    name: 'wotd',
    description: "Show today's Tlag word of the day",
  },
];
