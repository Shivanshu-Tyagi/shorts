const mongoose = require("mongoose");
const DownloadSchema = require("../models/download.model");
exports.getShortById = async (req, res) => {

  try {

    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        success: false,
        message: "Invalid id"
      });
    }

    const short = await DownloadSchema.findById(id);

    if (!short) {
      return res.status(404).json({
        success: false,
        message: "Short not found"
      });
    }

    return res.json({
      success: true,
      data: short
    });

  } catch (err) {

    console.error("Get short error:", err);

    return res.status(500).json({
      success: false,
      message: "Server error"
    });

  }

};
