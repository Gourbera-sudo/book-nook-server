import express from 'express';
import { MongoClient } from 'mongodb';
import 'dotenv/config';
import cors from 'cors';

const app = express()
app.use(cors());
app.use(express.json());
const port = 5000



const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db('book-nook');
const booksCollection = db.collection('all-books');

// app.post('/add-book', async (req, res) => {
//   const book = req.body;
//   const result = await booksCollection.insertOne(book);
//   res.send(result);
// });
app.get('/all-books', async (req, res) => {
  const result = await booksCollection.find().toArray();
  res.send(result);
}
  
)

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})