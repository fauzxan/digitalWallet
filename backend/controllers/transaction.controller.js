require("dotenv").config();
const { sign } = require("crypto");
const db = require("../models/index");
const Transaction = db.Transaction;
const User = db.User;
const sequelize = db.sequelize;
const axios = require("axios");
const Op = db.Sequelize.Op;
const stripe = require("stripe")(process.env.STRIPE_API_KEY);
const CryptoJS = require("crypto-js");

exports.createTransaction = async (req, res) => {
  // Authenticate Request
  if (req.header("Authorization") != process.env.API_KEY) {
    res.status(401).send({
      message: "Unauthorised!",
    });
    return;
  }
  // Validate request
  if (
    !req.body.from_email ||
    !req.body.to_email ||
    !req.body.amount ||
    req.body.amount < 0
  ) {
    res.status(400).send({
      message: "All fields are required or Amount is negative!",
    });
    return;
  }
  const from_email = req.body.from_email;
  const to_email = req.body.to_email;
  const amount = parseInt(req.body.amount);

  // Check if Valid
  const userSender = await User.findOne({
    where: { email: from_email },
  });
  const userReceiver = await User.findOne({
    where: { email: to_email },
  });

  if (!userReceiver || !userSender || from_email === to_email) {
    res.status(400).send({
      message: "User does not exist or User trying to send to himself!",
    });
    return;
  }
  let status_val = 1;
  if (amount > userSender.balance) {
    status_val = 0;
  } else {
    const url =
      "https://digital-wallet-plum.vercel.app/digiwallet/user/updatebalance";
    const dataSender = {
      email: from_email,
      amount: -amount,
    };
    const dataReceiver = {
      email: to_email,
      amount: amount,
    };
    const headers = {
      Authorization: process.env.API_KEY,
    };
    axios
      .post(url, dataSender, { headers })
      .then((response) => {
        console.log(
          `POST request to update balance of user:${from_email} successful:`,
          response.data
        );
      })
      .catch((error) => {
        console.error(
          `Error making POST request to update balance of user:${from_email} :`,
          error
        );
        status_val = 0;
      });
    axios
      .post(url, dataReceiver, { headers })
      .then((response) => {
        console.log(
          `POST request to update balance of user:${to_email} successful:`,
          response.data
        );
      })
      .catch((error) => {
        console.error(
          `Error making POST request to update balance of user:${to_email} :`,
          error
        );
        status_val = 0;
      });
  }
  // Create a Transaction
  const new_transaction = {
    to_email: to_email,
    from_email: from_email,
    from_name: userSender.name,
    to_name: userReceiver.name,
    amount: amount,
    status: status_val,
  };
  // Save Transaction in the database (Managed Transaction)
  try {
    const result = await sequelize.transaction(async (t) => {
      const createdTransaction = await Transaction.create(new_transaction, {
        transaction: t,
      });
      return createdTransaction;
    });
    if (status_val != 1) {
      res.status(250).json({
        message: "Transaction Logged successfully but failed",
        Transaction: result,
      });
    } else {
      res.status(201).json({
        message: "Transaction created successfully",
        Transaction: result,
      });
    }
  } catch (error) {
    console.error("Error creating Transaction:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.findAll = async (req, res) => {
  // Authenticate Request
  if (req.header("Authorization") != process.env.API_KEY) {
    res.status(401).send({
      message: "Unauthorised!",
    });
    return;
  }
  if (!req.query.email) {
    res.status(400).send({
      message: "No email!",
    });
    return;
  }
  const user = await User.findOne({
    where: { email: req.query.email },
  });
  if (!user) {
    res.status(400).send({
      message: "User not found!",
    });
    return;
  }
  // Validate request
  try {
    const transaction_history = await Transaction.findAll({
      where: {
        [Op.or]: [
          {
            to_email: {
              [Op.eq]: req.query.email,
            },
          },
          {
            from_email: {
              [Op.eq]: req.query.email,
            },
          },
        ],
      },
    });
    res.status(200).json({
      message: "All Transactions",
      Transaction: transaction_history,
      UserBalance: user.balance,
    });
  } catch (error) {
    console.error("Error while finding Transaction:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
};

exports.topupTransaction = async (req, res) => {
  if (req.header("Authorization") != process.env.API_KEY) {
    res.status(401).send({
      message: "Unauthorised Request!",
    });
    return;
  }
  if (!req.query.email || !req.query.amount) {
    res.status(400).send({
      message: "Invalid/Missing request object",
    });
  }
  const user = await User.findOne({ where: { email: req.query.email } });
  if (!user) {
    res.status(400).send({
      message: "User not found",
    });
  }
  // Stripe Checkout
  const session = await stripe.checkout.sessions.create({
    customer_email: user.email,
    submit_type: "pay",
    line_items: [
      {
        price_data: {
          currency: "sgd",
          unit_amount: req.query.amount * 100,
          product_data: {
            name: "Topup",
          },
        },
        quantity: 1,
      },
    ],
    mode: "payment",
    success_url: `https://digital-wallet-frontend-six.vercel.app/success`,
    cancel_url: `https://digital-wallet-frontend-six.vercel.app/failure`,
  });
  res.json({ url: session.url });
};
exports.topupBalance = async (req, res) => {
  if (req.header("Authorization") != process.env.API_KEY) {
    res.status(401).send({
      message: "Unauthorised!",
    });
    return;
  }
  if (
    !req.query.amount ||
    parseInt(req.query.amount) <= 0 ||
    !req.query.email
  ) {
    res.status(400).send({
      message: "Invalid request object: Missing Amount OR Missing email!",
    });
  }
  const user = await User.findOne({
    where: { email: req.query.email },
  });
  try {
    const result = await sequelize.transaction(async (t) => {
      const updatedRows = await user.update(
        { balance: user.balance + parseInt(req.query.amount) },
        { transaction: t }
      );
      return updatedRows;
    });
  } catch (error) {
    console.log(error);
  }
  // Create a Transaction
  const new_transaction = {
    to_email: user.email,
    from_email: 0,
    from_name: "Stripe",
    to_name: user.name,
    amount: parseInt(req.query.amount),
    status: 1,
  };
  // Save Transaction in the database (Managed Transaction)
  try {
    const result = await sequelize.transaction(async (t) => {
      const createdTransaction = await Transaction.create(new_transaction, {
        transaction: t,
      });
      return createdTransaction;
    });
  } catch (error) {
    console.error("Error creating Transaction:", error);
  }
  res.status(200).send({ message: "User balance successfully topped up" });
};
