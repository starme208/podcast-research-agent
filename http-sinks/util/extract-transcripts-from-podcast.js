import fs from 'fs';
import { parseStringPromise } from 'xml2js';
import { OpenAIWhisperAudio } from '@langchain/community/document_loaders/fs/openai_whisper_audio';
const { MongoClient } = require("mongodb");
const { ChatOpenAI } = require("@langchain/openai");
const { HumanMessage, SystemMessage } = require("@langchain/core/messages");
const axios = require("axios");
const MP3Cutter = require("mp3-cutter");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const dotenv = require("dotenv");

// Load environment variables from .env file
dotenv.config();

const uri = process.env.MONGODB_URI;

const model = new ChatOpenAI({ model: "gpt-4o-mini" });

const MAX_SIZE_MB = 25;

// Download the MP3 file
async function downloadMP3(url, outputPath) {
  const writer = fs.createWriteStream(outputPath);

  const response = await axios({
    url,
    method: 'GET',
    responseType: 'stream',
  });

  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

// Split the MP3 into chunks less than 25 MB
async function splitMP3(filePath) {
  let files = [];

  const maxSizeBytes = MAX_SIZE_MB * 1024 * 1024;

  // Get the size of the file
  const stats = fs.statSync(filePath);
  const fileSizeInBytes = stats.size;

  console.log('fileSizeInBytes: '+ fileSizeInBytes);

  if (fileSizeInBytes <= maxSizeBytes) {
    console.log('File is already less than 25 MB, no need to split.');
    return;
  }

  // Calculate the number of chunks needed
  const numberOfChunks = Math.ceil(fileSizeInBytes / maxSizeBytes);
  console.log(`Splitting the file into ${numberOfChunks} chunks...`);

  const chunkDurationInSeconds = await getChunkDurationInSeconds(filePath, numberOfChunks);

  console.log('chunkDurationInSeconds: ', chunkDurationInSeconds);

  for (let i = 0; i < numberOfChunks; i++) {
    const start = i * chunkDurationInSeconds;
    const end = (i + 1) * chunkDurationInSeconds;

    console.log(`start and end: ${start} ${end}`);

    const outputFileName = path.join(
      path.dirname(filePath),
      `chunk_${i + 1}_${path.basename(filePath)}`
    );
    
    MP3Cutter.cut({
      src: filePath,
      target: outputFileName,
      start,
      end,
    });

    console.log(`Chunk ${i + 1} saved as ${outputFileName}`);

    files.push(outputFileName);
  }

  return files;
}

// Helper function to get chunk duration in seconds based on file size
async function getChunkDurationInSeconds(filePath, numberOfChunks) {
  const MP3_DURATION_PER_MB = 24; // Approximate average duration of 1MB of MP3
  const totalDuration = MP3_DURATION_PER_MB * numberOfChunks * MAX_SIZE_MB;
  const chunkDuration = totalDuration / numberOfChunks;

  return chunkDuration;
}

// Main function to handle the download and splitting process
async function processMP3(url, downloadPath) {
  try {
    // Download the MP3 file
    console.log('Downloading MP3...');
    await downloadMP3(url, downloadPath);
    console.log('Download complete.');

    // Split the MP3 file into chunks
    let mp3Files = await splitMP3(downloadPath);
    console.log('Splitting complete.');

    console.log(mp3Files);

    return mp3Files;
  } catch (error) {
    console.error('Error processing MP3:', error);
  }
}

// Removes a single file from disc
async function removeFile(filePath) {
  fs.unlink(filePath, (err) => {
    if (err) {
      console.error('Error deleting file:', err);
    } else {
      console.log('File deleted successfully');
    }
  });
}

// Cleans up all downloaded and split files
async function cleanUpFiles(filePath, fileChunks) {
  removeFile(filePath);

  for(let i = 0; i < fileChunks.length; i++) {
    removeFile(fileChunks[i]);
  }
}

async function extractQuestions(text) {
  const userPrompt = `
      Input Transcript:
      ${text}
    `;

    const systemPrompt = `You are a podcast host and expert in AI, databases, and data engineering.
      
    Extract the most interesting questions asked from the Input Transcript text. Paraphrase them and
    seperate each one by a blank line. Do not number the questions.`;

    const messages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userPrompt),
    ];
    
    const response = await model.invoke(messages);
    let questions = response.content;

    return questions;
}

// Function to transcribe the MP3 file using Whisper API
async function transcribeAudio(mp3Url) {
  let transcriptions = [];
  const filePath = process.cwd() + '/files/' + uuidv4() + '.mp3';
  let mp3Files = await processMP3(mp3Url, filePath);

  // Transcribe all the MP3 chunks
  for (let i = 0; i < mp3Files.length; i++) {
    let mp3FileChunkName = mp3Files[i];

    console.log('Transcribing ', mp3FileChunkName);

    try {
      const loader = new OpenAIWhisperAudio(mp3FileChunkName);
      const docs = await loader.load();

      let transcription = docs[0].pageContent;
      transcriptions.push(transcription);
    } catch(e) {
      console.log(e); // log error but continue
    }
    
    // break;
  }

  cleanUpFiles(filePath, mp3Files);

  return transcriptions;
}

// Extracts the podcast title out of the Apple podcast episode URL
function extractAndFormatTitle(url) {
  // Match the title part of the URL using a regular expression
  const match = url.match(/podcast\/([^/]+)\//);
  if (!match) {
    return null; // Return null if the title part isn't found
  }
  
  // Extract the title part and replace dashes with spaces, then convert to lowercase
  const kebabTitle = match[1];
  const formattedTitle = kebabTitle.replace(/-/g, ' ').toLowerCase();
  
  return formattedTitle;
}

// Extracts the Apple podcast ID out of the URL
function extractPodcastId(url) {
  const match = url.match(/\/id(\d+)\b/);
  return match ? match[1] : null;
}

async function extractAndSaveQuestions(bundleId, transcriptions) {
  console.log("extractAndSaveQuestions");
  let questions = "";

  for (let i = 0; i < transcriptions.length; i++) {
    questions += await extractQuestions(transcriptions[i]) + "\n";
    questions = questions.replace(/\s*\n\s*/g, '\n');
  }

  const client = new MongoClient(uri);

  try {
    await client.connect();
    const database = client.db("podpre_ai");
    const collection = database.collection("research_questions");

    // Insert data into the collection
    const result = await collection.insertOne({
      bundleId: bundleId,
      questions: questions
    });
    
    return result;
  } catch (error) {
    console.error("Error updating research bundle:", error);
    throw error;
  } finally {
    await client.close();
  }
}

module.exports = {
  // Saves the text chunks, bundle IDs, and URLs to a Kafka topic
  processPodcastURL: async function(bundleId, url) {
    let podcastId = extractPodcastId(url);
    let titleToMatch = extractAndFormatTitle(url);

    console.log("titleToMatch: " + titleToMatch);
    
    if (podcastId) {
      let feedLookupUrl = `https://itunes.apple.com/lookup?id=${podcastId}&entity=podcast`;

      const itunesResponse = await axios.get(feedLookupUrl);
      const itunesData = itunesResponse.data;

      // Check if results were returned
      if (itunesData.resultCount === 0 || !itunesData.results[0].feedUrl) {
        console.error("No feed URL found for this podcast ID.");
        return;
      }

      // Extract the feed URL
      const feedUrl = itunesData.results[0].feedUrl;
      console.log("Feed URL:", feedUrl);

      // Fetch the document from the feed URL
      const feedResponse = await axios.get(feedUrl);
      const rssContent = feedResponse.data;

      // Parse the RSS feed XML
      const rssData = await parseStringPromise(rssContent);

      const episodes = rssData.rss.channel[0].item; // Access all items (episodes) in the feed

      // Find the matching episode by title, have to transform title to match the URL-based title
      const matchingEpisode = episodes.find(episode => 
        episode.title[0].replace(/[^a-z0-9 ]/gi, '').toLowerCase().includes(titleToMatch)
      );

      if (!matchingEpisode) {
        console.log(`No episode found with title containing "${titleToMatch}"`);
        return;
      }

      // Extract the MP3 URL from the enclosure tag
      const mp3Url = matchingEpisode.enclosure[0].$.url;
      console.log("MP3 URL:", mp3Url);

      let transcriptions = await transcribeAudio(mp3Url);

      extractAndSaveQuestions(bundleId, transcriptions);
      
      return transcriptions;
    }

    return [];
  }
}