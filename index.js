import express from 'express';
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';
import { jwtVerify } from 'jose';

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

const port = 5000;

const DB_NAME = 'book-nook';
const BOOKS_COLLECTION = 'all-books';
const ADD_BOOK_COLLECTION = 'add-book';
const BORROWS_COLLECTION = 'borrows';

const JWT_ISSUER = 'book-nook';
const JWT_AUDIENCE = 'book-nook-api';
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required to verify API requests.');
}

const jwtKey = new TextEncoder().encode(JWT_SECRET);

// Seeded catalog books were added before copy tracking existed. Treat them as
// a single available copy until a borrow/return writes real counters.
const DEFAULT_COPIES = 1;

const BOOK_FIELDS = ['title', 'author', 'category', 'image', 'description'];

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

const db = mongoClient.db(DB_NAME);
const catalogCollection = db.collection(BOOKS_COLLECTION);
const submissionsCollection = db.collection(ADD_BOOK_COLLECTION);
const borrowsCollection = db.collection(BORROWS_COLLECTION);

// A reader may hold only one active borrow per book, but different readers can
// borrow different copies of the same title. Replace the old per-book index.
try {
  await borrowsCollection.dropIndex('bookId_1');
} catch (err) {
  if (err?.codeName !== 'IndexNotFound') {
    console.warn('Could not drop the legacy borrow index:', err?.message);
  }
}

await borrowsCollection.createIndex(
  { bookId: 1, borrowerEmail: 1 },
  { unique: true, partialFilterExpression: { status: 'borrowed' } },
);

await borrowsCollection.createIndex({ borrowerEmail: 1, status: 1 });

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

function normalizeCopies(book) {
  const total =
    Number.isInteger(book.totalCopies) && book.totalCopies >= 0
      ? book.totalCopies
      : DEFAULT_COPIES;
  const available = Number.isInteger(book.availableCopies)
    ? Math.min(Math.max(book.availableCopies, 0), total)
    : total;

  return { ...book, totalCopies: total, availableCopies: available };
}

function readCopies(value) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_COPIES;
  }

  const copies = Number(value);

  if (!Number.isInteger(copies) || copies < 1) {
    return null;
  }

  return copies;
}

function readBearerToken(req) {
  const header = String(req.headers.authorization ?? '');
  const [scheme, token] = header.split(' ');

  if (!/^bearer$/i.test(scheme) || !token) {
    return null;
  }

  return token.trim();
}

// Verifies the short-lived JWT minted by the Next.js token endpoint.
// Returns null for missing, invalid, or expired tokens.
async function getJwtUser(req) {
  const token = readBearerToken(req);

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, jwtKey, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    const email = normalizeEmail(payload.email);

    if (!email) {
      return null;
    }

    return {
      user: {
        id: payload.sub ?? null,
        email,
        name: String(payload.name ?? '').trim(),
      },
      email,
      name: String(payload.name ?? '').trim(),
    };
  } catch {
    return null;
  }
}

function requireAuth(req, res, next) {
  getJwtUser(req)
    .then((auth) => {
      if (!auth) {
        return res.status(401).send({ error: 'You must be signed in to do that' });
      }

      req.auth = auth;
      next();
    })
    .catch((err) => {
      console.error(err);
      res.status(500).send({ error: 'Failed to verify your session' });
    });
}

async function findBook(id) {
  const candidates = ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id];

  for (const candidateId of candidates) {
    const catalogBook = await catalogCollection.findOne({ _id: candidateId });

    if (catalogBook) {
      return { book: catalogBook, collection: catalogCollection };
    }

    const submittedBook = await submissionsCollection.findOne({ _id: candidateId });

    if (submittedBook) {
      return { book: submittedBook, collection: submissionsCollection };
    }
  }

  return null;
}

// Seeded and legacy books may not have copy counters yet. Add them once so
// later $inc updates start from a real number instead of -1.
async function ensureCopyFields(found) {
  await found.collection.updateOne(
    {
      _id: found.book._id,
      $or: [
        { totalCopies: { $exists: false } },
        { availableCopies: { $exists: false } },
      ],
    },
    [
      {
        $set: {
          totalCopies: { $ifNull: ['$totalCopies', DEFAULT_COPIES] },
          availableCopies: {
            $ifNull: [
              '$availableCopies',
              { $ifNull: ['$totalCopies', DEFAULT_COPIES] },
            ],
          },
        },
      },
    ],
  );
}

// Give a returned copy back without ever exceeding the recorded total.
async function incrementAvailableCopies(bookId) {
  const found = await findBook(bookId);

  if (!found) {
    return null;
  }

  await ensureCopyFields(found);

  const updated = await found.collection.findOneAndUpdate(
    {
      _id: found.book._id,
      $expr: { $lt: ['$availableCopies', '$totalCopies'] },
    },
    { $inc: { availableCopies: 1 } },
    { returnDocument: 'after' },
  );

  return updated ?? found.collection.findOne({ _id: found.book._id });
}

function mergeBooks(catalog, submissions) {
  const seen = new Set();
  const merged = [];

  for (const book of [...catalog, ...submissions]) {
    const key = String(book._id);

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(normalizeCopies(book));
  }

  return merged;
}

function readBookFields(body) {
  const values = {};
  const missing = [];

  for (const field of BOOK_FIELDS) {
    const value = String(body?.[field] ?? '').trim();

    if (!value) {
      missing.push(field);
    }

    values[field] = value;
  }

  return { values, missing };
}

function withBorrowStatus(book, activeBorrow, email) {
  return {
    ...book,
    activeBorrow: activeBorrow
      ? {
          _id: String(activeBorrow._id),
          borrowerName: activeBorrow.borrowerName ?? '',
          borrowedAt: activeBorrow.borrowedAt ?? null,
          borrowedByMe: Boolean(email && activeBorrow.borrowerEmail === email),
        }
      : null,
  };
}

// GET /books - all books (public).
app.get('/books', async (req, res) => {
  try {
    const [catalog, submissions] = await Promise.all([
      catalogCollection.find().toArray(),
      submissionsCollection.find().sort({ createdAt: -1 }).toArray(),
    ]);

    res.send(mergeBooks(catalog, submissions));
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to fetch books' });
  }
});

// GET /books/:id - one book. The JWT is optional and only used to flag
// whether the signed-in reader already has an active borrow of this book.
app.get('/books/:id', async (req, res) => {
  try {
    const found = await findBook(req.params.id);

    if (!found) {
      return res.status(404).send({ error: 'Book not found' });
    }

    const auth = await getJwtUser(req);
    const activeBorrow = auth
      ? await borrowsCollection.findOne({
          bookId: String(found.book._id),
          borrowerEmail: auth.email,
          status: 'borrowed',
        })
      : null;

    res.send(
      withBorrowStatus(normalizeCopies(found.book), activeBorrow, auth?.email ?? ''),
    );
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to fetch book' });
  }
});

// POST /books - add a book owned by the signed-in user.
app.post('/books', requireAuth, async (req, res) => {
  try {
    const { values, missing } = readBookFields(req.body);

    if (missing.length > 0) {
      return res
        .status(400)
        .send({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    const totalCopies = readCopies(req.body?.totalCopies);

    if (totalCopies === null) {
      return res
        .status(400)
        .send({ error: 'Total copies must be a whole number of at least 1' });
    }

    const book = {
      ...values,
      totalCopies,
      availableCopies: totalCopies,
      userName: req.auth.name,
      userEmail: req.auth.email,
      createdAt: new Date(),
    };

    const result = await submissionsCollection.insertOne(book);
    res.status(201).send({ ...book, _id: result.insertedId });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to add book' });
  }
});

// PATCH /books/:id - update a book owned by the signed-in user.
app.patch('/books/:id', requireAuth, async (req, res) => {
  try {
    const found = await findBook(req.params.id);

    if (!found) {
      return res.status(404).send({ error: 'Book not found' });
    }

    const ownerEmail = normalizeEmail(found.book.userEmail);

    if (!ownerEmail || ownerEmail !== req.auth.email) {
      return res.status(403).send({ error: 'You can only edit your own books' });
    }

    const { values, missing } = readBookFields(req.body);

    if (missing.length > 0) {
      return res
        .status(400)
        .send({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    await found.collection.updateOne(
      { _id: found.book._id },
      { $set: { ...values, updatedAt: new Date() } },
    );

    const updated = await found.collection.findOne({ _id: found.book._id });
    res.send(normalizeCopies(updated));
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to update book' });
  }
});

// DELETE /books/:id - delete a book owned by the signed-in user.
app.delete('/books/:id', requireAuth, async (req, res) => {
  try {
    const found = await findBook(req.params.id);

    if (!found) {
      return res.status(404).send({ error: 'Book not found' });
    }

    const ownerEmail = normalizeEmail(found.book.userEmail);

    if (!ownerEmail || ownerEmail !== req.auth.email) {
      return res.status(403).send({ error: 'You can only delete your own books' });
    }

    const activeBorrow = await borrowsCollection.findOne({
      bookId: String(found.book._id),
      status: 'borrowed',
    });

    if (activeBorrow) {
      return res
        .status(409)
        .send({ error: 'This book is currently borrowed and cannot be deleted' });
    }

    await found.collection.deleteOne({ _id: found.book._id });
    res.send({ success: true, _id: String(found.book._id) });
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to delete book' });
  }
});

// POST /borrows - borrow a book as the signed-in user.
app.post('/borrows', requireAuth, async (req, res) => {
  try {
    const bookId = String(req.body?.bookId ?? '').trim();

    if (!bookId) {
      return res.status(400).send({ error: 'bookId is required' });
    }

    const found = await findBook(bookId);

    if (!found) {
      return res.status(404).send({ error: 'Book not found' });
    }

    const ownerEmail = normalizeEmail(found.book.userEmail);

    if (ownerEmail && ownerEmail === req.auth.email) {
      return res.status(400).send({ error: 'You cannot borrow your own book' });
    }

    const existingBorrow = await borrowsCollection.findOne({
      bookId: String(found.book._id),
      borrowerEmail: req.auth.email,
      status: 'borrowed',
    });

    if (existingBorrow) {
      return res
        .status(409)
        .send({ error: 'You have already borrowed this book' });
    }

    // Atomically take one copy with $inc. The filter fails when every copy is
    // out, so two readers cannot claim the same last copy.
    await ensureCopyFields(found);

    const updatedBook = await found.collection.findOneAndUpdate(
      { _id: found.book._id, availableCopies: { $gt: 0 } },
      { $inc: { availableCopies: -1 } },
      { returnDocument: 'after' },
    );

    if (!updatedBook) {
      return res
        .status(409)
        .send({ error: 'No copies of this book are available right now' });
    }

    const borrow = {
      bookId: String(found.book._id),
      bookTitle: found.book.title ?? '',
      bookAuthor: found.book.author ?? '',
      bookImage: found.book.image ?? '',
      bookCategory: found.book.category ?? '',
      ownerName: found.book.userName ?? '',
      ownerEmail,
      borrowerName: req.auth.name,
      borrowerEmail: req.auth.email,
      status: 'borrowed',
      borrowedAt: new Date(),
      returnedAt: null,
    };

    try {
      const result = await borrowsCollection.insertOne(borrow);
      res.status(201).send({
        ...borrow,
        _id: result.insertedId,
        totalCopies: updatedBook.totalCopies,
        availableCopies: updatedBook.availableCopies,
      });
    } catch (error) {
      // Put the copy back if the borrow record could not be written.
      await incrementAvailableCopies(String(found.book._id));

      if (error?.code === 11000) {
        return res
          .status(409)
          .send({ error: 'You have already borrowed this book' });
      }

      throw error;
    }
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to borrow book' });
  }
});

// GET /borrows - the signed-in user's borrows.
app.get('/borrows', requireAuth, async (req, res) => {
  try {
    const borrows = await borrowsCollection
      .find({ borrowerEmail: req.auth.email })
      .sort({ status: 1, borrowedAt: -1 })
      .toArray();

    res.send(borrows);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to fetch your borrows' });
  }
});

// DELETE /borrows/:id - return a book borrowed by the signed-in user.
app.delete('/borrows/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ error: 'Invalid borrow ID' });
    }

    const borrowId = new ObjectId(id);
    const borrow = await borrowsCollection.findOne({ _id: borrowId });

    if (!borrow) {
      return res.status(404).send({ error: 'Borrow not found' });
    }

    if (borrow.borrowerEmail !== req.auth.email) {
      return res
        .status(403)
        .send({ error: 'Only the borrower can return this book' });
    }

    if (borrow.status !== 'returned') {
      // Only the request that flips the status may add the copy back, so
      // double-clicking Return cannot inflate availability.
      const returned = await borrowsCollection.findOneAndUpdate(
        { _id: borrowId, status: 'borrowed' },
        { $set: { status: 'returned', returnedAt: new Date() } },
        { returnDocument: 'after' },
      );

      if (returned) {
        await incrementAvailableCopies(borrow.bookId);
      }
    }

    const updated = await borrowsCollection.findOne({ _id: borrowId });
    res.send(updated);
  } catch (err) {
    console.error(err);
    res.status(500).send({ error: 'Failed to return book' });
  }
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
