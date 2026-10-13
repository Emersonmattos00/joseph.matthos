"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.emailVerificationTokensRelations = exports.passwordResetTokensRelations = exports.rentalsRelations = exports.rentalProductsRelations = exports.plansRelations = exports.subscriptionsRelations = exports.artistsRelations = exports.albumsRelations = exports.orderItemsRelations = exports.tracksRelations = exports.playbackEventsRelations = exports.ordersRelations = exports.usersRelations = exports.refreshTokensRelations = void 0;
const relations_1 = require("drizzle-orm/relations");
const schema_1 = require("./schema");
exports.refreshTokensRelations = (0, relations_1.relations)(schema_1.refreshTokens, ({ one }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.refreshTokens.userId],
        references: [schema_1.users.id]
    }),
}));
exports.usersRelations = (0, relations_1.relations)(schema_1.users, ({ many }) => ({
    refreshTokens: many(schema_1.refreshTokens),
    orders: many(schema_1.orders),
    playbackEvents: many(schema_1.playbackEvents),
    subscriptions: many(schema_1.subscriptions),
    rentals: many(schema_1.rentals),
    passwordResetTokens: many(schema_1.passwordResetTokens),
    emailVerificationTokens: many(schema_1.emailVerificationTokens),
}));
exports.ordersRelations = (0, relations_1.relations)(schema_1.orders, ({ one, many }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.orders.userId],
        references: [schema_1.users.id]
    }),
    orderItems: many(schema_1.orderItems),
    rentals: many(schema_1.rentals),
}));
exports.playbackEventsRelations = (0, relations_1.relations)(schema_1.playbackEvents, ({ one }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.playbackEvents.userId],
        references: [schema_1.users.id]
    }),
    track: one(schema_1.tracks, {
        fields: [schema_1.playbackEvents.trackId],
        references: [schema_1.tracks.id]
    }),
}));
exports.tracksRelations = (0, relations_1.relations)(schema_1.tracks, ({ one, many }) => ({
    playbackEvents: many(schema_1.playbackEvents),
    album: one(schema_1.albums, {
        fields: [schema_1.tracks.albumId],
        references: [schema_1.albums.id]
    }),
    artist: one(schema_1.artists, {
        fields: [schema_1.tracks.artistId],
        references: [schema_1.artists.id]
    }),
    rentalProducts: many(schema_1.rentalProducts),
    rentals: many(schema_1.rentals),
}));
exports.orderItemsRelations = (0, relations_1.relations)(schema_1.orderItems, ({ one }) => ({
    order: one(schema_1.orders, {
        fields: [schema_1.orderItems.orderId],
        references: [schema_1.orders.id]
    }),
}));
exports.albumsRelations = (0, relations_1.relations)(schema_1.albums, ({ one, many }) => ({
    tracks: many(schema_1.tracks),
    artist: one(schema_1.artists, {
        fields: [schema_1.albums.artistId],
        references: [schema_1.artists.id]
    }),
    rentalProducts: many(schema_1.rentalProducts),
    rentals: many(schema_1.rentals),
}));
exports.artistsRelations = (0, relations_1.relations)(schema_1.artists, ({ many }) => ({
    tracks: many(schema_1.tracks),
    albums: many(schema_1.albums),
}));
exports.subscriptionsRelations = (0, relations_1.relations)(schema_1.subscriptions, ({ one }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.subscriptions.userId],
        references: [schema_1.users.id]
    }),
    plan: one(schema_1.plans, {
        fields: [schema_1.subscriptions.planId],
        references: [schema_1.plans.id]
    }),
}));
exports.plansRelations = (0, relations_1.relations)(schema_1.plans, ({ many }) => ({
    subscriptions: many(schema_1.subscriptions),
}));
exports.rentalProductsRelations = (0, relations_1.relations)(schema_1.rentalProducts, ({ one }) => ({
    track: one(schema_1.tracks, {
        fields: [schema_1.rentalProducts.trackId],
        references: [schema_1.tracks.id]
    }),
    album: one(schema_1.albums, {
        fields: [schema_1.rentalProducts.albumId],
        references: [schema_1.albums.id]
    }),
}));
exports.rentalsRelations = (0, relations_1.relations)(schema_1.rentals, ({ one }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.rentals.userId],
        references: [schema_1.users.id]
    }),
    track: one(schema_1.tracks, {
        fields: [schema_1.rentals.trackId],
        references: [schema_1.tracks.id]
    }),
    album: one(schema_1.albums, {
        fields: [schema_1.rentals.albumId],
        references: [schema_1.albums.id]
    }),
    order: one(schema_1.orders, {
        fields: [schema_1.rentals.orderId],
        references: [schema_1.orders.id]
    }),
}));
exports.passwordResetTokensRelations = (0, relations_1.relations)(schema_1.passwordResetTokens, ({ one }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.passwordResetTokens.userId],
        references: [schema_1.users.id]
    }),
}));
exports.emailVerificationTokensRelations = (0, relations_1.relations)(schema_1.emailVerificationTokens, ({ one }) => ({
    user: one(schema_1.users, {
        fields: [schema_1.emailVerificationTokens.userId],
        references: [schema_1.users.id]
    }),
}));
