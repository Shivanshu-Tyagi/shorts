const admin = require("../config/firebase");

const sendMulticastNotification = async ({
  tokens,
  title,
  body,
  data = {},
}) => {
  if (!Array.isArray(tokens) || tokens.length === 0) {
    return {
      totalTokens: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
      errorCounts: {},
    };
  }

  const uniqueTokens = [
    ...new Set(
      tokens.filter(
        (token) =>
          typeof token === "string" &&
          token.trim().length > 0
      )
    ),
  ];

  if (!uniqueTokens.length) {
    return {
      totalTokens: 0,
      successCount: 0,
      failureCount: 0,
      invalidTokens: [],
      errorCounts: {},
    };
  }

  if (uniqueTokens.length > 500) {
    throw new Error(
      `Maximum 500 tokens allowed. Received ${uniqueTokens.length}`
    );
  }

  const message = {
    tokens: uniqueTokens,

    notification: {
      title,
      body,
    },

    data: Object.fromEntries(
      Object.entries(data).map(([key, value]) => [
        key,
        String(value),
      ])
    ),

    android: {
      priority: "high",
      notification: {
        sound: "default",
        channelId: "default",
      },
    },

    apns: {
      payload: {
        aps: {
          sound: "default",
        },
      },
    },
  };

  const response =
    await admin
      .messaging()
      .sendEachForMulticast(message);

  const invalidTokens = [];
  const errorCounts = {};

  response.responses.forEach((result, index) => {
    if (result.success) {
      return;
    }

    const errorCode =
      result.error?.code || "UNKNOWN";

    const errorMessage =
      result.error?.message || "Unknown error";

    errorCounts[errorCode] =
      (errorCounts[errorCode] || 0) + 1;

    console.error(
      "FCM FAILED:",
      errorCode,
      errorMessage
    );

    if (
      errorCode ===
        "messaging/registration-token-not-registered" ||
      errorCode ===
        "messaging/invalid-registration-token"
    ) {
      invalidTokens.push(
        uniqueTokens[index]
      );
    }
  });

  return {
    totalTokens: uniqueTokens.length,
    successCount: response.successCount,
    failureCount: response.failureCount,
    invalidTokens,
    errorCounts,
  };
};

module.exports = {
  sendMulticastNotification,
};