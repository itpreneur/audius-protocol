from datetime import datetime

import pytest
from integration_tests.utils import populate_mock_db
from src.queries.get_user_listen_counts_monthly import (
    GetUserListenCountsMonthlyArgs,
    _get_user_listen_counts_monthly,
    get_user_listen_counts_monthly,
)
from src.utils.db_session import get_db

test_entities = {
    "aggregate_monthly_plays": [
        {
            "play_item_id": 1,
            "timestamp": "2022-01-01",
            "count": 7,
        },
        {
            "play_item_id": 2,
            "timestamp": "2022-01-01",
            "count": 2,
        },
        {
            "play_item_id": 1,
            "timestamp": "2021-12-31",
            "count": 7,
        },
        {
            "play_item_id": 1,
            "timestamp": "2023-01-01",
            "count": 2,
        },
        {
            "play_item_id": 4,
            "timestamp": "2022-02-01",
            "count": 10,
        },
    ],
    "tracks": [
        {"track_id": 1, "title": "track 1", "owner_id": 1},
        {"track_id": 4, "title": "track 1", "owner_id": 1},
        {"track_id": 2, "title": "track 2", "owner_id": 2},
    ],
    "users": [
        {"user_id": 1, "handle": "user-1"},
        {"user_id": 2, "handle": "user-2"},
    ],
}


def test_get_user_listen_counts_monthly_query(app):
    """Tests happy path of getting user listen counts"""
    with app.app_context():
        db = get_db()

        populate_mock_db(db, test_entities)

        with db.scoped_session():
            user_listen_counts_monthly = get_user_listen_counts_monthly(
                GetUserListenCountsMonthlyArgs(
                    user_id=1,
                    start_time="2022-01-01",
                    end_time="2023-01-01",
                ),
            )
        assert len(user_listen_counts_monthly) == 2
        # User 1 only owns track ids 1 and 4
        for listen_count in user_listen_counts_monthly:
            listen_count_timestamp = datetime.combine(
                listen_count["timestamp"], datetime.min.time()
            )
            assert listen_count["play_item_id"] in [1, 4]
            assert listen_count_timestamp >= datetime.strptime("2022-01-01", "%Y-%m-%d")
            assert listen_count_timestamp < datetime.strptime("2023-01-01", "%Y-%m-%d")


def test_get_user_listen_counts_missing_arg(app):
    """Tests happy path of getting user listen counts"""
    with app.app_context():
        db = get_db()

    populate_mock_db(db, test_entities)

    with db.scoped_session() as session:
        with pytest.raises(KeyError):
            _get_user_listen_counts_monthly(
                session,
                GetUserListenCountsMonthlyArgs(
                    user_id=1,
                    end_time="2023-01-01",
                ),
            )


# def test_get_user_listen_counts_monthly_formatting(app):
#     expected_formatted_data = {
#         "2022-01-01T00:00:00 Z": {
#             "totalListens": 7,
#             "trackIds": [1],
#             "listenCounts": [
#                 {
#                     "trackId": 1,
#                     "date": "2022-01-01T00:00:00 Z",
#                     "listens": 7,
#                 }
#             ],
#         },
#         "2022-02-01T00:00:00 Z": {
#             "totalListens": 10,
#             "trackIds": [4],
#             "listenCounts": [
#                 {
#                     "trackId": 4,
#                     "date": "2022-02-01T00:00:00 Z",
#                     "listens": 10,
#                 }
#             ],
#         },
#     }
#     with app.app_context():
#         db = get_db()

#         populate_mock_db(db, test_entities)

#         with db.scoped_session():
#             user_listen_counts_monthly = get_user_listen_counts_monthly(
#                 GetUserListenCountsMonthlyArgs(
#                     user_id=1,
#                     start_time="2022-01-01",
#                     end_time="2023-01-01",
#                 ),
#             )
#             assert user_listen_counts_monthly == expected_formatted_data


# def test_get_user_listen_counts_monthly_formatting_sums_total(app):
#     test_entities["aggregate_monthly_plays"].append(
#         {
#             "play_item_id": 4,
#             "timestamp": "2022-01-01",
#             "count": 1,
#         }
#     )
#     expected_formatted_data = {
#         "2022-01-01T00:00:00 Z": {
#             "totalListens": 8,
#             # order matters for list elements
#             "trackIds": [4, 1],
#             "listenCounts": [
#                 {
#                     "trackId": 4,
#                     "date": "2022-01-01T00:00:00 Z",
#                     "listens": 1,
#                 },
#                 {
#                     "trackId": 1,
#                     "date": "2022-01-01T00:00:00 Z",
#                     "listens": 7,
#                 },
#             ],
#         },
#         "2022-02-01T00:00:00 Z": {
#             "totalListens": 10,
#             "trackIds": [4],
#             "listenCounts": [
#                 {
#                     "trackId": 4,
#                     "date": "2022-02-01T00:00:00 Z",
#                     "listens": 10,
#                 }
#             ],
#         },
#     }
#     with app.app_context():
#         db = get_db()

#         populate_mock_db(db, test_entities)

#         with db.scoped_session():
#             user_listen_counts_monthly = get_user_listen_counts_monthly(
#                 GetUserListenCountsMonthlyArgs(
#                     user_id=1,
#                     start_time="2022-01-01",
#                     end_time="2023-01-01",
#                 ),
#             )
#             assert user_listen_counts_monthly == expected_formatted_data
