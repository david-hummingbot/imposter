const fs = require('fs');
const path = require('path');

const WORDS_FILE = path.join(__dirname, 'words.json');

const DEFAULT_WORDS = [
  "Pizza", "Sushi", "Chocolate", "Coffee", "Banana", "Avocado", "Hamburger",
  "Ice Cream", "Popcorn", "Strawberry", "Watermelon", "Pancakes", "Tacos",
  "Doughnut", "Lemonade", "Spaghetti", "Cupcake", "Salmon", "Pineapple",
  "Elephant", "Penguin", "Giraffe", "Dolphin", "Kangaroo", "Panther",
  "Octopus", "Flamingo", "Cheetah", "Gorilla", "Jellyfish", "Peacock",
  "Chameleon", "Crocodile", "Butterfly",
  "Umbrella", "Telescope", "Bicycle", "Backpack", "Lighthouse", "Compass",
  "Microphone", "Skateboard", "Trampoline", "Hammock", "Chandelier",
  "Binoculars", "Sundial", "Escalator", "Magnifying Glass",
  "Beach", "Library", "Museum", "Casino", "Volcano", "Castle",
  "Airport", "Stadium", "Submarine", "Jungle", "Desert", "Glacier",
  "Skyscraper", "Cathedral", "Treehouse",
  "Surfing", "Archery", "Wrestling", "Fencing", "Gymnastics", "Paragliding",
  "Scuba Diving", "Bowling", "Skydiving", "Rock Climbing",
  "Satellite", "Robot", "Drone", "Hologram", "Smartphone", "Elevator",
  "Solar Panel", "Microscope", "3D Printer",
  "Rainbow", "Tornado", "Avalanche", "Thunderstorm", "Eclipse", "Meteor",
  "Coral Reef", "Quicksand", "Northern Lights", "Tsunami",
  "Magic Show", "Circus", "Fireworks", "Karaoke", "Puppet", "Carnival",
  "Escape Room", "Drive-In Movie",
];

function loadWords() {
  try {
    if (fs.existsSync(WORDS_FILE)) {
      const data = fs.readFileSync(WORDS_FILE, 'utf8');
      const words = JSON.parse(data);
      if (Array.isArray(words) && words.length > 0) {
        return words.filter(word => typeof word === 'string' && word.trim().length > 0);
      }
    }
  } catch (err) {
    console.warn(`Could not load words.json, using default list: ${err.message}`);
  }
  return DEFAULT_WORDS;
}

const WORDS = loadWords();

function getRandomWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

module.exports = { getRandomWord };