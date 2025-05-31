const mongoose = require('mongoose');

const MonitoredUserSchema = new mongoose.Schema({
    username: { type: String, required: true, lowercase: true, index: true },
    chatId: { type: String, required: true, index: true },
    addedByUserId: { type: String, required: true },
}, { timestamps: true });

MonitoredUserSchema.index({ username: 1, chatId: 1 }, { unique: true });

const FollowerHistorySchema = new mongoose.Schema({
    username: { type: String, required: true, lowercase: true, index: true },
    scrapedUsername: { type: String, lowercase: true },
    userFullname: String,
    userDescription: String,
    userProfilePic: String,
    userProfilePicHash: String,
    isPrivate: Boolean,
    followersCount: Number,
    followingCount: Number,
    postsCount: Number,
    isVerified: Boolean,
    rawFollowers: String,
    rawFollowing: String,
    rawPosts: String,
    apiResponseJson: mongoose.Schema.Types.Mixed,
}, { timestamps: { createdAt: true, updatedAt: false } });

FollowerHistorySchema.index({ username: 1, createdAt: -1 });

const StoryHistorySchema = new mongoose.Schema({
    username: { type: String, required: true, lowercase: true, index: true },
    mediaUrl: { type: String, required: true },
    mediaType: { type: String, enum: ['photo', 'video'], required: true },
    storyTimestamp: { type: Date, required: true, index: true }, // When the story was posted
    processedAt: { type: Date, default: Date.now },
    sentTo: [{ type: String }] // Array of chat IDs where this story was sent
}, { timestamps: true });

// Compound index to efficiently find stories by username and timestamp
StoryHistorySchema.index({ username: 1, storyTimestamp: -1 });

const postHistorySchema = new mongoose.Schema({
    username: { type: String, required: true, index: true },
    postId: { type: String, required: true },
    mediaUrl: { type: String, required: true },
    mediaType: { type: String, enum: ['photo', 'video'], required: true },
    caption: { type: String },
    timestamp: { type: Date, required: true },
    processedAt: { type: Date, required: true },
    sentTo: [{ type: String }]
}, { timestamps: true });

// Compound index to efficiently find posts by username and postId
postHistorySchema.index({ username: 1, postId: 1 }, { unique: true });

const PostHistory = mongoose.model('PostHistory', postHistorySchema);

module.exports = {
    MonitoredUser: mongoose.model('MonitoredUser', MonitoredUserSchema, 'monitored_users'),
    FollowerHistory: mongoose.model('FollowerHistory', FollowerHistorySchema, 'follower_history'),
    StoryHistory: mongoose.model('StoryHistory', StoryHistorySchema, 'story_history'),
    PostHistory
};
