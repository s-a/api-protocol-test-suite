const { faker } = require('@faker-js/faker/locale/en')

const imageCategories = Object.fromEntries(
  ['abstract', 'animals', 'business', 'cats', 'city', 'fashion', 'food', 'nature', 'nightlife', 'people', 'sports', 'transport']
    .map(category => [category, () => `https://loremflickr.com/640/480/${category}?lock=${faker.number.int()}`]),
)

// Postman Collection 5.3 calls Faker's legacy method names without arguments,
// except for number ranges and its fixed phone format.
module.exports = {
  address: { ...faker.location, streetName: faker.location.street },
  commerce: { ...faker.commerce, color: faker.color.human },
  company: {
    ...faker.company,
    companyName: faker.company.name,
    companySuffix: () => faker.helpers.arrayElement(faker.definitions.company.legal_entity_type),
    bs: faker.company.buzzPhrase,
    bsAdjective: faker.company.buzzAdjective,
    bsBuzz: faker.company.buzzVerb,
    bsNoun: faker.company.buzzNoun,
  },
  database: faker.database,
  datatype: { boolean: faker.datatype.boolean, number: faker.number.int, uuid: faker.string.uuid },
  date: faker.date,
  finance: { ...faker.finance, account: faker.finance.accountNumber, mask: () => `(${faker.string.numeric(4)})` },
  hacker: faker.hacker,
  image: {
    ...imageCategories,
    imageUrl: () => faker.image.url({ width: 640, height: 480 }),
    dataUri: () => faker.image.dataUri({ type: 'svg-uri' }),
  },
  internet: { ...faker.internet, color: faker.color.rgb, userName: faker.internet.username },
  lorem: faker.lorem,
  name: { ...faker.person, findName: faker.person.fullName },
  phone: { phoneNumberFormat: () => faker.helpers.replaceSymbols('###-###-####') },
  random: { alphaNumeric: faker.string.alphanumeric, arrayElement: faker.helpers.arrayElement, word: faker.word.sample },
  system: faker.system,
}
