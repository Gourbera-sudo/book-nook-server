
import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

const port = 5000;

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('Successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.error('MongoDB connection error:', err);
    throw err;
  }
}

const mongoClient = await connectToMongoDB();

const DB_NAME = 'book-nook';
const BOOKS_COLLECTION = 'all-books';
const ADD_BOOK_COLLECTION = 'add-book';

const db = mongoClient.db(DB_NAME);
const booksCollection = db.collection(BOOKS_COLLECTION);
const addBookCollection = db.collection(ADD_BOOK_COLLECTION);

function mergeBooks(catalog, submissions) {
  const seen = new Set();
  const merged = [];

  for (const book of [...catalog, ...submissions]) {
    const key = String(book._id);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(book);
  }

  return merged;
}

app.get('/all-books', async (req, res) => {
  try {
    const [catalog, submissions] = await Promise.all([
      booksCollection.find().toArray(),
      addBookCollection.find().sort({ createdAt: -1 }).toArray(),
    ]);

    res.send(mergeBooks(catalog, submissions));
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to fetch books' });
  }
});

app.get('/my-books', async (req, res) => {
  try {
    const email = String(req.query.email ?? '').trim().toLowerCase();

    if (!email) {
      return res.status(400).send({ error: 'Missing email query parameter' });
    }

    const books = await addBookCollection
      .find({ userEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(books);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to fetch your books' });
  }
});



// app.post('/add-book', async (req, res) => {
//   try {
//     const { title, author, category, image, description, userName, userEmail } = req.body ?? {};

//     const missing = [
//       ['title', title],
//       ['author', author],
//       ['category', category],
//       ['image', image],
//       ['description', description],
//     ]
//       .filter(([, value]) => !value || !String(value).trim())
//       .map(([field]) => field);

//     if (missing.length > 0) {
//       return res.status(400).send({ error: `Missing required fields: ${missing.join(', ')}` });
//     }

//     const book = {
//       title: String(title).trim(),
//       author: String(author).trim(),
//       category: String(category).trim(),
//       image: String(image).trim(),
//       description: String(description).trim(),
//       userName: String(userName ?? '').trim(),
//       userEmail: String(userEmail ?? '').trim().toLowerCase(),
//       createdAt: new Date(),
//     };

//     const result = await addBookCollection.insertOne(book);
//     res.status(201).send({ ...book, _id: result.insertedId });
//   } catch (err) {
//     console.error(err);
//     res.status(500).send({ error: 'Failed to add book' });
//   }
// });



app.get('/all-books/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const candidateIds = ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id];

    let book = null;

    for (const candidateId of candidateIds) {
      book = await booksCollection.findOne({ _id: candidateId });

      if (!book) {
        book = await addBookCollection.findOne({ _id: candidateId });
      }

      if (book) {
        break;
      }
    }

    if (!book) {
      return res.status(404).send({ error: 'Book not found' });
    }

    res.send(book);

  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
