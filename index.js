const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
require('dotenv').config()
const express = require('express')
const cors = require('cors')
const crypto = require("crypto");
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
// const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const admin = require('firebase-admin')

const port = process.env.PORT || 5000

// Firebase Admin Setup
const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf-8')
const serviceAccount = JSON.parse(decoded)
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
})

const app = express()

// Middleware
app.use(
  cors({
    origin: ['localhost:5173', process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())
app.use(express.urlencoded({ extended: true }));
// jwt middlewares
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    next()
  } catch (err) {
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// MongoDB Connection
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})

// async function run() {
//   try {
const db = client.db('orderFoodDb')
const mealsCollection = db.collection('meals')
const ordersCollection = db.collection('orders')
const usersCollection = db.collection('users')
const paymentsHistoryCollection = db.collection('payments')
const reviewsCollection = db.collection('reviews')
const favoritesCollection = db.collection('favorites')
const roleRequestCollection = db.collection('roleRequest')
const chefCollection = db.collection('chef')



// ====================== Save Or update a user in db ======================
app.post('/role-requests', verifyJWT, async (req, res) => {
  const chef = req.body
  const exists = await roleRequestCollection.findOne({
    userEmail: chef.userEmail,
    requestStatus: 'pending'
  })
  if (exists) {
    return res.status(409).send({ message: 'Request already pending' })
  }
  const result = await roleRequestCollection.insertOne(chef)
  res.send(result)
})

app.get('/role-requests', verifyJWT, async (req, res) => {
  const query = {}
  if (req.query.requestStatus) {
    query.requestStatus = req.query.requestStatus
  }
  const cursor = roleRequestCollection.find(query)
  const result = await cursor.toArray()
  res.send(result)

})

// Approve a role request
app.patch('/role-requests/approve/:id', verifyJWT, async (req, res) => {
  const { id } = req.params
  const { userEmail, photoUrl, name, role } = req.body
  try {
    const request = await roleRequestCollection.findOne({ _id: new ObjectId(id) })
    if (!request) return res.status(404).send({ message: 'Request not found' })
    const adminUser = await usersCollection.findOne({ email: req.tokenEmail })
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).send({ message: 'Forbidden Access!' })
    }


    // Update user role
    const updateUserData = { role }
    let chefId = null
    if (role === 'chef') {
      // Generate unique chefId
      chefId = `chef-${Math.floor(1000 + Math.random() * 9000)}`
      updateUserData.chefId = chefId
      await chefCollection.insertOne({
        chefId,
        userEmail,
        photoUrl,
        name,
        createdAt: new Date(),
        verified: true,
        rating: 0,
        totalOrders: 0
      })


    }
    await usersCollection.updateOne(
      { email: userEmail },
      {
        $set: {
          email: userEmail,
          ...updateUserData
        }
      }
    )
    // Update request status
    await roleRequestCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { requestStatus: 'approved', approvedAt: new Date(), chefId } }
    )

    res.send({ success: true, message: 'Request approved' })
  } catch (err) {
    console.error(err)
    res.status(500).send({ success: false, message: 'Server error', err })
  }
})

// Reject a role request
app.patch('/role-requests/reject/:id', verifyJWT, async (req, res) => {
  const { id } = req.params

  try {
    await roleRequestCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { requestStatus: 'rejected', rejectedAt: new Date() } }
    )
    res.send({ success: true, message: 'Request rejected' })
  } catch (err) {
    console.error(err)
    res.status(500).send({ success: false, message: 'Server error', err })
  }
})


// ====================== Customer ======================
app.post('/customer', async (req, res) => {
  const customer = req.body;
  customer.role = 'customer';
  customer.status = 'active';
  customer.createdAt = new Date();
  const result = await usersCollection.insertOne(customer);
  res.send(result);
})
// ====================== CUSTOMER STATISTICS ======================
app.get('/customer/statistics', verifyJWT, async (req, res) => {
  try {
    const email = req.tokenEmail;

    // 1. Total Orders count by category
    const totalOrders = await ordersCollection.countDocuments({ customerEmail: email });
    const pendingOrders = await ordersCollection.countDocuments({ customerEmail: email, orderStatus: 'pending' });
    const deliveredOrders = await ordersCollection.countDocuments({ customerEmail: email, orderStatus: 'delivered' });

    // 2. Total Expenditures (Aggregated from payments collection)
    const expenditureAgg = await paymentsHistoryCollection.aggregate([
      { $match: { customerEmail: email } },
      {
        $group: {
          _id: null,
          totalSpent: { $sum: '$amount' }
        }
      }
    ]).toArray();
    const totalSpent = expenditureAgg.length > 0 ? expenditureAgg[0].totalSpent : 0;

    // 3. Activity Interactions Count (Reviews & Favorites counts)
    const totalReviews = await reviewsCollection.countDocuments({ userEmail: email, type: { $ne: 'chef_review' } });
    const totalFavorites = await favoritesCollection.countDocuments({ userEmail: email });

    res.send({
      totalOrders,
      pendingOrders,
      deliveredOrders,
      totalSpent,
      totalReviews,
      totalFavorites
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: 'Server error processing customer insights' });
  }
});

app.get('/user/role', verifyJWT, async (req, res) => {
  try {
    const result = await usersCollection.findOne({ email: req.tokenEmail })
    if (!result) return res.status(404).send({ message: 'User not found' })
    res.send({ role: result.role, result })
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error', err })
  }
})

// ====================== MANAGE USERS (ADMIN) ======================
app.get('/users', verifyJWT, async (req, res) => {
  try {
    // Only admins can view this
    const adminUser = await usersCollection.findOne({ email: req.tokenEmail });
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).send({ message: 'Forbidden Access!' });
    }

    const users = await usersCollection.find().sort({ createdAt: -1 }).toArray();
    res.send(users);
  } catch (err) {
    console.error(err);
    res.status(500).send({ message: 'Server error' });
  }
});

// PATCH: Make user fraud
app.patch('/users/fraud/:id', verifyJWT, async (req, res) => {
  const adminUser = await usersCollection.findOne({ email: req.tokenEmail })
  if (!adminUser || adminUser.role !== 'admin') {
    return res.status(403).send({ message: 'Forbidden Access!' })
  }

  const userId = req.params.id
  const user = await usersCollection.findOne({ _id: new ObjectId(userId) })
  if (!user) return res.status(404).send({ message: 'User not found' })

  // mark user fraud
  await usersCollection.updateOne(
    { _id: user._id },
    { $set: { status: 'fraud' } }
  )

  // IMPORTANT PART (Chef cleanup)
  if (user.role === 'chef' && user.chefId) {
    await chefCollection.updateOne(
      { chefId: user.chefId },
      { $set: { verified: false, disabledAt: new Date() } }
    )
  }

  res.send({ success: true, message: 'User marked as fraud' })
})

app.patch('/users/status/:id', verifyJWT, async (req, res) => {
  try {
    const adminUser = await usersCollection.findOne({
      email: req.tokenEmail,
    })

    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).send({
        message: 'Forbidden Access!',
      })
    }

    const { id } = req.params
    const { status } = req.body

    if (!['active', 'blocked'].includes(status)) {
      return res.status(400).send({
        message: 'Invalid status',
      })
    }

    const result = await usersCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    )

    if (result.modifiedCount === 0) {
      return res.status(404).send({
        message: 'User not found',
      })
    }

    res.send({
      success: true,
      message: `User ${status} successfully`,
    })
  } catch (error) {
    console.error(error)
    res.status(500).send({
      message: 'Server Error',
    })
  }
})



// ====================== CHEFS ======================
// GET featured chefs
app.get('/chefs/featured', async (req, res) => {
  try {
    const chefs = await chefCollection
      .find({ verified: true })
      .sort({ rating: -1, totalOrders: -1 })

      .toArray()
    res.send(chefs)
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
})

// GET all chefs
app.get('/chefs', async (req, res) => {
  try {
    const chefs = await chefCollection
      .find({ verified: true })
      .sort({ createdAt: -1 })
      .toArray()
    res.send(chefs)
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
})

// GET single chef by ID
app.get('/chefs/:id', async (req, res) => {
  try {
    const { id } = req.params
    const chef = await chefCollection.findOne({
      $or: [
        { _id: ObjectId.isValid(id) ? new ObjectId(id) : null },
        { chefId: id }
      ]
    })
    if (!chef) return res.status(404).send({ message: 'Chef not found' })
    res.send(chef)
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
})

// ====================== MEALS ======================
app.post('/add-meal', verifyJWT, async (req, res) => {
  const mealData = req.body
  const result = await mealsCollection.insertOne(mealData)
  res.send(result)
})

app.get('/meals', async (req, res) => {
  const result = await mealsCollection
    .find()
    .sort({ createdAt: -1 })
    .toArray()

  res.send(result)
})

// GET popular meals
app.get('/meals/popular', async (req, res) => {
  try {
    const meals = await mealsCollection
      .find({})
      .sort({ averageRating: -1, totalReviews: -1 })
      .limit(8)
      .toArray()
    res.send(meals)
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
})


app.get('/meals/:id', async (req, res) => {
  const id = req.params.id
  if (!ObjectId.isValid(id)) return res.status(400).send({ message: 'Invalid ID' })
  const result = await mealsCollection.findOne({ _id: new ObjectId(id) })
  if (!result) return res.status(404).send({ message: 'Meal not found' })
  res.send(result)
})

// GET meals by chef ID
app.get('/meals/chef/:chefId', async (req, res) => {
  try {
    const { chefId } = req.params
    const meals = await mealsCollection
      .find({ chefId: chefId })
      .sort({ createdAt: -1 })
      .toArray()
    res.send(meals)
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
})

// ====================== REVIEWS ======================
app.post('/reviews', async (req, res) => {
  const reviewData = req.body
  reviewData.date = new Date().toISOString()
  reviewData.type = 'food_review' // Differentiate from chef reviews

  // Insert review
  const result = await reviewsCollection.insertOne(reviewData)

  // Calculate new averageRating
  const reviews = await reviewsCollection.find({ foodId: reviewData.foodId }).toArray()
  const avgRating =
    reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length

  // Update meal's averageRating
  await mealsCollection.updateOne(
    { _id: new ObjectId(reviewData.foodId) },
    { $set: { averageRating: avgRating } }
  )

  res.send({ success: true, review: result, newAverageRating: avgRating })
})

// GET /reviews/latest
app.get('/reviews/latest', async (req, res) => {
  const reviews = await reviewsCollection
    .find({ type: { $ne: 'chef_review' } })
    .sort({ date: -1 })
    .limit(5)
    .toArray();
  res.send(reviews);
});

// GET featured reviews (highest rated)
app.get('/reviews/featured', async (req, res) => {
  try {
    const reviews = await reviewsCollection
      .find({ type: { $ne: 'chef_review' } })
      .sort({ rating: -1, date: -1 })
      .limit(6)
      .toArray();
    res.send(reviews);
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
});

app.patch('/reviews/:id', async (req, res) => {
  const { rating, comment, foodId } = req.body

  await reviewsCollection.updateOne(
    { _id: new ObjectId(req.params.id) },
    {
      $set: {
        rating,
        comment,
        date: new Date().toISOString(),
      },
    }
  )

  await updateFoodRating(foodId)

  res.send({ success: true })
})


app.get('/reviews/:mealId', async (req, res) => {
  const mealId = req.params.mealId
  const reviews = await reviewsCollection
    .find({
      foodId: mealId,
      type: { $ne: 'chef_review' } // Exclude chef reviews
    })
    .sort({ date: -1 })
    .toArray()
  res.send(reviews)
})


app.get('/my-review/:email', async (req, res) => {
  const email = req.params.email
  const orders = await reviewsCollection.find({
    userEmail: email,
    type: { $ne: 'chef_review' }
  }).sort({ date: -1 }).toArray()
  res.send(orders)
})

app.delete('/reviews/:id', async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) }
  const result = await reviewsCollection.deleteOne(query);
  res.send(result);
})

// ====================== CHEF REVIEWS ======================
// POST chef review
app.post('/reviews/chef', async (req, res) => {
  try {
    const { chefId, chefName, rating, comment, reviewerName, userEmail } = req.body

    if (!chefId || !rating || !comment) {
      return res.status(400).send({ message: 'Missing required fields' })
    }

    const chefReviewData = {
      chefId,
      chefName,
      rating: parseInt(rating),
      comment,
      reviewerName: reviewerName || 'Anonymous',
      userEmail: userEmail || 'unknown',
      date: new Date().toISOString(),
      type: 'chef_review'
    }

    const result = await reviewsCollection.insertOne(chefReviewData)

    // Update chef rating
    await updateChefRating(chefId)

    res.send({ success: true, review: result })
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error', err })
  }
})

// GET chef reviews
app.get('/reviews/chef/:chefId', async (req, res) => {
  try {
    const { chefId } = req.params
    const reviews = await reviewsCollection
      .find({
        chefId: chefId,
        type: 'chef_review'
      })
      .sort({ date: -1 })
      .toArray()
    res.send(reviews)
  } catch (err) {
    console.error(err)
    res.status(500).send({ message: 'Server error' })
  }
})

// ====================== REVIEWS & RATING ======================

const updateFoodRating = async (foodId) => {
  const stats = await reviewsCollection
    .aggregate([
      { $match: { foodId } },
      {
        $group: {
          _id: '$foodId',
          avgRating: { $avg: '$rating' },
          totalReviews: { $sum: 1 },
        },
      },
    ])
    .toArray()

  let ratingData = {
    averageRating: 0,
    totalReviews: 0,
  }

  if (stats.length > 0) {
    ratingData = {
      averageRating: Number(stats[0].avgRating.toFixed(1)),
      totalReviews: stats[0].totalReviews,
    }
  }

  await mealsCollection.updateOne(
    { _id: new ObjectId(foodId) },
    { $set: ratingData }
  )
}

// Update chef rating from reviews
const updateChefRating = async (chefId) => {
  const stats = await reviewsCollection
    .aggregate([
      {
        $match: {
          chefId: chefId,
          type: 'chef_review'
        }
      },
      {
        $group: {
          _id: '$chefId',
          avgRating: { $avg: '$rating' },
          totalReviews: { $sum: 1 },
        },
      },
    ])
    .toArray()

  let ratingData = {
    rating: 0,
    totalReviews: 0,
  }

  if (stats.length > 0) {
    ratingData = {
      rating: Number(stats[0].avgRating.toFixed(1)),
      totalReviews: stats[0].totalReviews,
    }
  }

  await chefCollection.updateOne(
    { chefId: chefId },
    { $set: ratingData }
  )
}

// ====================== FAVORITES ======================

// POST /favorites
app.post('/favorites', async (req, res) => {
  const { userEmail, mealId, mealName, chefId, chefName, price } = req.body

  // Check if the meal is already in favorites
  const existing = await favoritesCollection.findOne({ userEmail, mealId })
  if (existing) {
    return res.status(409).send({ message: 'Meal already in favorites' })
  }

  const favoriteData = {
    userEmail,
    mealId,
    mealName,
    chefId,
    chefName,
    price,
    addedTime: new Date().toISOString(),
  }

  const result = await favoritesCollection.insertOne(favoriteData)
  res.send({ success: true, favorite: result })
})

// GET /favorites/:userEmail
app.get('/favorites/:email', async (req, res) => {
  const email = req.params.email
  const favorites = await favoritesCollection
    .find({ userEmail: email })
    .sort({ addedTime: -1 })
    .toArray()
  res.send(favorites)

})

// DELETE /favorites/:id
app.delete('/favorites/:id', async (req, res) => {
  const id = req.params.id
  try {
    const result = await favoritesCollection.deleteOne({ _id: new ObjectId(id) })
    if (result.deletedCount === 1) {
      res.send({ success: true })
    } else {
      res.status(404).send({ success: false, message: 'Favorite not found' })
    }
  } catch (err) {
    res.status(500).send({ success: false, message: 'Server error' })
  }
})


// ====================== Seller ======================

app.post('/orders', async (req, res) => {
  const orderData = req.body
  orderData.orderTime = new Date().toISOString()
  orderData.paymentStatus = 'pending'
  orderData.orderStatus = 'pending'

  const result = await ordersCollection.insertOne(orderData)
  res.send(result)
})

// Get seller Created Meals
app.get('/seller-created-meals/:email', async (req, res) => {
  const email = req.params.email
  const meals = await mealsCollection.find({ createdBy: email }).sort({ orderTime: -1 }).toArray()
  res.send(meals)
})
app.get('/orders/total-payment/stats', async (req, res) => {
  const pipeline = [
    {
      $group: {
        _id: '$amount',
        count: { $sum: 1 }
      }
    }
  ]

  const result = await paymentsHistoryCollection.aggregate(pipeline).toArray();
  res.send(result);


})

// ====================== ADMIN STATISTICS ======================
app.get('/admin/statistics', verifyJWT, async (req, res) => {
  try {
    // check admin
    const adminUser = await usersCollection.findOne({ email: req.tokenEmail })
    if (!adminUser || adminUser.role !== 'admin') {
      return res.status(403).send({ message: 'Forbidden Access!' })
    }

    // Total users
    const totalUsers = await usersCollection.countDocuments()

    // Orders stats
    const pendingOrders = await ordersCollection.countDocuments({
      orderStatus: 'pending',
    })

    const deliveredOrders = await ordersCollection.countDocuments({
      orderStatus: 'delivered',
    })

    // Total payment amount
    const paymentAgg = await paymentsHistoryCollection.aggregate([
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
        },
      },
    ]).toArray()

    const totalPaymentAmount =
      paymentAgg.length > 0 ? paymentAgg[0].totalAmount : 0

    res.send({
      totalUsers,
      pendingOrders,
      deliveredOrders,
      totalPaymentAmount,
    })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Server error' })
  }
})

// ====================== PUBLIC STATISTICS ======================
app.get('/stats', async (req, res) => {
  try {
    // Total users
    const totalUsers = await usersCollection.countDocuments()

    // Total meals
    const totalMeals = await mealsCollection.countDocuments()

    // Total chefs
    const totalChefs = await chefCollection.countDocuments({ verified: true })

    // Total orders
    const totalOrders = await ordersCollection.countDocuments()

    // Average rating (from meals)
    const ratingAgg = await mealsCollection.aggregate([
      {
        $group: {
          _id: null,
          avgRating: { $avg: '$averageRating' },
        },
      },
    ]).toArray()

    const averageRating = ratingAgg.length > 0 ? Number(ratingAgg[0].avgRating.toFixed(1)) : 0

    // Cities covered (from meals delivery areas)
    const citiesAgg = await mealsCollection.aggregate([
      { $unwind: '$deliveryArea' },
      { $group: { _id: '$deliveryArea' } },
      { $count: 'totalCities' }
    ]).toArray()

    const citiesCovered = citiesAgg.length > 0 ? citiesAgg[0].totalCities : 0

    res.send({
      totalUsers,
      totalMeals,
      totalChefs,
      totalOrders,
      averageRating,
      citiesCovered
    })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Server error' })
  }
})


app.get('/all-orders', verifyJWT, async (req, res) => {

  const user = await usersCollection.findOne({
    email: req.tokenEmail
  })

  if (!user) {
    return res.status(401).send({
      message: 'Unauthorized Access!'
    })
  }

  // Admin can view all orders
  if (user.role === 'admin') {

    const orders = await ordersCollection.find().toArray()

    return res.send(orders)
  }

  return res.status(403).send({
    message: 'Forbidden Access!'
  })
})
app.delete('/order-cancel/:id', verifyJWT, async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) }
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
})


app.delete('/seller-created-meals/:id', async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) }
  const result = await mealsCollection.deleteOne(query);
  res.send(result);
})
// ====================== Order ======================
app.get('/my-orders/:email', verifyJWT, async (req, res) => {
  const email = req.params.email
  const orders = await ordersCollection.find({ customerEmail: email }).sort({ orderTime: -1 }).toArray()
  res.send(orders)
})
app.delete('/my-order/:id', async (req, res) => {
  const id = req.params.id;
  const query = { _id: new ObjectId(id) }
  const result = await ordersCollection.deleteOne(query);
  res.send(result);
})

// Update order status by admin
app.patch('/orders/status/:id', verifyJWT, async (req, res) => {
  try {
    const user = await usersCollection.findOne({
      email: req.tokenEmail,
    })

    if (!user || user.role !== 'admin') {
      return res.status(403).send({
        message: 'Admin only',
      })
    }

    const { status } = req.body

    if (!['pending', 'accepted', 'delivered', 'cancelled'].includes(status)) {
      return res.status(400).send({
        message: 'Invalid status',
      })
    }

    const result = await ordersCollection.updateOne(
      { _id: new ObjectId(req.params.id) },
      {
        $set: {
          orderStatus: status,
          updatedAt: new Date(),
        },
      }
    )

    res.send(result)
  } catch (error) {
    console.log(error)
    res.status(500).send({
      message: 'Server Error',
    })
  }
})




app.patch("/update-meal/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const updatedMeal = req.body;
    const userEmail = updatedMeal.userEmail;

    const filter = {
      _id: new ObjectId(id),
      createdBy: userEmail
    };

    const updateDoc = {
      $set: {
        ...updatedMeal,
        updatedAt: new Date().toISOString(),
      },
    };

    const result = await mealsCollection.updateOne(
      filter,
      updateDoc
    );

    res.send(result);

  } catch (error) {
    console.error(error);
    res.status(500).send({
      message: "Failed to update meal",
      error
    });
  }
});


app.post("/payhere/initiate", verifyJWT, async (req, res) => {
  const { orderId } = req.body;
  console.log("/payhere/initiate", req.body)

  const order = await ordersCollection.findOne({ _id: new ObjectId(orderId) });
  console.log(order)
  if (!order) return res.status(404).send({ message: "Order not found" });
  if (order.customerEmail !== req.tokenEmail) {
    return res.status(403).send({ message: "Forbidden Access!" });
  }

  const merchantId = process.env.PAYHERE_MERCHANT_ID;
  const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET;

  const hashedSecret = crypto
    .createHash("md5")
    .update(merchantSecret)
    .digest("hex")
    .toUpperCase();

  const amount = Number(order.price * order.quantity).toFixed(2);
  const currency = "USD";

  const hash = crypto
    .createHash("md5")
    .update(merchantId + orderId + amount + currency + hashedSecret)
    .digest("hex")
    .toUpperCase();

  res.send({
    merchantId,
    hash,
    orderId,
    amount,
    currency,
    mealName: order.mealName,
    notifyUrl: `${process.env.SERVER_DOMAIN}/payhere-notify`,
  });
});

app.post("/payhere-notify", async (req, res) => {
  console.log ("/payhere-notify", req.body)
  const {
    merchant_id,
    order_id,
    payment_id,
    payhere_amount,
    payhere_currency,
    status_code,
    md5sig,
  } = req.body;

  const merchantSecret = process.env.PAYHERE_MERCHANT_SECRET;
  const hashedSecret = crypto
    .createHash("md5")
    .update(merchantSecret)
    .digest("hex")
    .toUpperCase();

  const localSig = crypto
    .createHash("md5")
    .update(
      merchant_id +
      order_id +
      payhere_amount +
      payhere_currency +
      status_code +
      hashedSecret
    )
    .digest("hex")
    .toUpperCase();

  if (localSig !== md5sig) {
    console.warn("Invalid PayHere signature — possible spoofed request");
    return res.sendStatus(400);
  }

  if (status_code === "2") {
    // optional but recommended: also verify payhere_amount matches your stored order total
    const order = await ordersCollection.findOne({ _id: new ObjectId(order_id) });
    if (order && Number(order.price * order.quantity).toFixed(2) === Number(payhere_amount).toFixed(2)) {
      await ordersCollection.updateOne(
        { _id: new ObjectId(order_id) },
        { $set: { paymentStatus: "paid", transactionId: payment_id } }
      );

      await paymentsHistoryCollection.insertOne({
        orderId: order_id,
        transactionId: payment_id,
        amount: payhere_amount,
        customerEmail: order.customerEmail,
        paymentStatus: "paid",
        paidAt: new Date(),
      });
    }
  }

  res.sendStatus(200);
});

app.get("/orders/:id/status", verifyJWT, async (req, res) => {
  const order = await ordersCollection.findOne({ _id: new ObjectId(req.params.id) });
  if (!order) return res.status(404).send({ message: "Order not found" });
  if (order.customerEmail !== req.tokenEmail) return res.status(403).send({ message: "Forbidden" });
  res.send({ paymentStatus: order.paymentStatus });
});

// Payment Success
// app.patch('/payment-success', async (req, res) => {
//   const sessionId = req.query.session_id

//   const session = await stripe.checkout.sessions.retrieve(sessionId)
//   const transactionId = session.payment_intent;
//   const query = { transactionId: transactionId }

//   const paymentExist = await paymentsHistoryCollection.findOne(query);
//   if (paymentExist) {
//     return res.send({
//       message: 'already exists',
//       transactionId,
//       trackingId: paymentExist.trackingId
//     })
//   }

//   // use the previous tracking id created during the parcel create which was set to the session metadata during session creation
//   const trackingId = session.metadata.trackingId;




//   if (session.payment_status === 'paid') {
//     const id = session.metadata.mealId;
//     const query = { _id: new ObjectId(id) }
//     const update = {
//       $set: {
//         paymentStatus: 'paid',
//         trackingId: trackingId,
//       },
//     }

//     const result = await ordersCollection.updateOne(query, update);

//     const payment = {
//       amount: session.amount_total / 100,
//       currency: session.currency,
//       customerEmail: session.customer_email,
//       mealId: session.metadata.mealId,
//       mealName: session.metadata.mealName,
//       transactionId: session.payment_intent,
//       paymentStatus: session.payment_status,
//       paidAt: new Date(),
//       trackingId: trackingId

//     }

//     if (session.payment_status === 'paid') {
//       const resultPayment = await paymentsHistoryCollection.insertOne(payment);
//       res.send({
//         success: true,
//         modifyOrder: result,
//         paymentInfo: resultPayment
//       })
//     }

//     return res.send(result)
//   }
//   return res.send({ success: false })

// })

//payment history
app.get('/payments', verifyJWT, async (req, res) => {
  const email = req.query.email;
  const query = {}
  if (email) {
    query.customerEmail = email;
    // check email from token
    if (email !== req.tokenEmail) {
      return res.status(403).send({ message: 'Forbidden Access!' })
    }
  }
  const payments = await paymentsHistoryCollection.find(query).sort({ paidAt: -1 }).toArray();
  res.send(payments);
})


app.get('/', (req, res) => {
  res.send('Food Ordering Server is running smoothly!')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})