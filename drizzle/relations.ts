import { relations } from "drizzle-orm/relations";
import { users, refreshTokens, orders, playbackEvents, tracks, orderItems, albums, artists, emailVerificationTokens, subscriptions, plans, rentalProducts, passwordResetTokens, rentals } from "./schema";

export const refreshTokensRelations = relations(refreshTokens, ({one}) => ({
	user: one(users, {
		fields: [refreshTokens.userId],
		references: [users.id]
	}),
}));

export const usersRelations = relations(users, ({many}) => ({
	refreshTokens: many(refreshTokens),
	orders: many(orders),
	playbackEvents: many(playbackEvents),
	emailVerificationTokens: many(emailVerificationTokens),
	subscriptions: many(subscriptions),
	passwordResetTokens: many(passwordResetTokens),
	rentals: many(rentals),
}));

export const ordersRelations = relations(orders, ({one, many}) => ({
	user: one(users, {
		fields: [orders.userId],
		references: [users.id]
	}),
	orderItems: many(orderItems),
	rentals: many(rentals),
}));

export const playbackEventsRelations = relations(playbackEvents, ({one}) => ({
	user: one(users, {
		fields: [playbackEvents.userId],
		references: [users.id]
	}),
	track: one(tracks, {
		fields: [playbackEvents.trackId],
		references: [tracks.id]
	}),
}));

export const tracksRelations = relations(tracks, ({one, many}) => ({
	playbackEvents: many(playbackEvents),
	album: one(albums, {
		fields: [tracks.albumId],
		references: [albums.id]
	}),
	artist: one(artists, {
		fields: [tracks.artistId],
		references: [artists.id]
	}),
	rentalProducts: many(rentalProducts),
	rentals: many(rentals),
}));

export const orderItemsRelations = relations(orderItems, ({one}) => ({
	order: one(orders, {
		fields: [orderItems.orderId],
		references: [orders.id]
	}),
}));

export const albumsRelations = relations(albums, ({one, many}) => ({
	tracks: many(tracks),
	rentalProducts: many(rentalProducts),
	rentals: many(rentals),
	artist: one(artists, {
		fields: [albums.artistId],
		references: [artists.id]
	}),
}));

export const artistsRelations = relations(artists, ({many}) => ({
	tracks: many(tracks),
	albums: many(albums),
}));

export const emailVerificationTokensRelations = relations(emailVerificationTokens, ({one}) => ({
	user: one(users, {
		fields: [emailVerificationTokens.userId],
		references: [users.id]
	}),
}));

export const subscriptionsRelations = relations(subscriptions, ({one}) => ({
	user: one(users, {
		fields: [subscriptions.userId],
		references: [users.id]
	}),
	plan: one(plans, {
		fields: [subscriptions.planId],
		references: [plans.id]
	}),
}));

export const plansRelations = relations(plans, ({many}) => ({
	subscriptions: many(subscriptions),
}));

export const rentalProductsRelations = relations(rentalProducts, ({one}) => ({
	track: one(tracks, {
		fields: [rentalProducts.trackId],
		references: [tracks.id]
	}),
	album: one(albums, {
		fields: [rentalProducts.albumId],
		references: [albums.id]
	}),
}));

export const passwordResetTokensRelations = relations(passwordResetTokens, ({one}) => ({
	user: one(users, {
		fields: [passwordResetTokens.userId],
		references: [users.id]
	}),
}));

export const rentalsRelations = relations(rentals, ({one}) => ({
	user: one(users, {
		fields: [rentals.userId],
		references: [users.id]
	}),
	track: one(tracks, {
		fields: [rentals.trackId],
		references: [tracks.id]
	}),
	album: one(albums, {
		fields: [rentals.albumId],
		references: [albums.id]
	}),
	order: one(orders, {
		fields: [rentals.orderId],
		references: [orders.id]
	}),
}));