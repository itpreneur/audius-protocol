import logging
from typing import Dict

from src.models.tracks.track import Track
from src.models.users.user import User
from src.tasks.entity_manager.user_replica_set import parse_sp_ids
from src.tasks.entity_manager.utils import (
    USER_ID_OFFSET,
    Action,
    EntityType,
    ManageEntityParameters,
    copy_user_record,
)
from src.tasks.user_replica_set import get_endpoint_string_from_sp_ids
from src.tasks.users import (
    update_legacy_user_images,
    update_user_metadata,
    validate_user_record,
)
from src.utils.config import shared_config

logger = logging.getLogger(__name__)


def get_verifier_address():
    if "verified_address" in shared_config["contracts"]:
        return shared_config["contracts"]["verified_address"]


def validate_user_tx(params: ManageEntityParameters):
    user_id = params.user_id

    if params.entity_type != EntityType.USER:
        raise Exception("Invalid User Transaction, wrong entity type")

    if params.action == Action.CREATE:
        if user_id in params.existing_records[EntityType.USER]:
            raise Exception("Invalid User Transaction, user already exists")
        if user_id < USER_ID_OFFSET:
            raise Exception("Invalid User Transaction, user id offset incorrect")
    elif params.action == Action.UPDATE:
        # update / delete specific validations
        if user_id not in params.existing_records[EntityType.USER]:
            raise Exception("Invalid User Transaction, user does not exist")
        wallet = params.existing_records[EntityType.USER][user_id].wallet
        if wallet and wallet.lower() != params.signer.lower():
            raise Exception(
                "Invalid User Transaction, user wallet signer does not match"
            )
    elif params.action == Action.VERIFY:
        verifier_address = get_verifier_address()
        if not verifier_address or verifier_address.lower() != params.signer.lower():
            raise Exception(
                "Invalid User Transaction, signer does not match verifier address"
            )
    else:
        raise Exception(
            f"Invalid User Transaction, action {params.action} is not valid"
        )


def validate_user_metadata(session, user_record: User, user_metadata: Dict):
    # If the user's handle is not set, validate that it is unique
    if not user_record.handle:
        user_handle_exists = session.query(
            session.query(User).filter(User.handle == user_metadata["handle"]).exists()
        ).scalar()
        if user_handle_exists:
            # Invalid user handle - should not continue to save...
            return
        user_record.handle = user_metadata["handle"]
        user_record.handle_lc = user_metadata["handle"].lower()

    # If an artist pick track id is specified, validate that it is a valid track id
    if (
        "artist_pick_track_id" in user_metadata
        and user_metadata["artist_pick_track_id"]
    ):
        track_id_exists = session.query(
            session.query(Track)
            .filter(
                Track.is_current == True,
                Track.track_id == user_metadata["artist_pick_track_id"],
                Track.owner_id == user_record.user_id,
            )
            .exists()
        ).scalar()
        if not track_id_exists:
            # Invalid artist pick. Should not continue to save
            return

    return user_record


def update_user_record(params: ManageEntityParameters, user: User, metadata: Dict):
    update_user_metadata(
        params.session, params.redis, user, metadata, params.web3, params.challenge_bus
    )
    user.metadata_multihash = params.metadata_cid
    user = update_legacy_user_images(user)
    user = validate_user_record(user)
    return user


def create_user(params: ManageEntityParameters):
    validate_user_tx(params)

    user_id = params.user_id

    user_record = User(
        user_id=user_id,
        wallet=params.signer.lower(),
        txhash=params.txhash,
        blockhash=params.event_blockhash,
        blocknumber=params.block_number,
        created_at=params.block_datetime,
        updated_at=params.block_datetime,
        is_current=False,
    )

    sp_ids = parse_sp_ids(params.metadata_cid)

    # Update the user's new replica set in the model and save!
    user_record.primary_id = sp_ids[0]
    user_record.secondary_ids = sp_ids[1:]

    # Update cnode endpoint string reconstructed from sp ID
    creator_node_endpoint_str = get_endpoint_string_from_sp_ids(
        params.redis, sp_ids[0], sp_ids[1:]
    )
    user_record.creator_node_endpoint = creator_node_endpoint_str

    user_record = validate_user_record(user_record)
    params.add_user_record(user_id, user_record)
    return user_record


def update_user(params: ManageEntityParameters):
    validate_user_tx(params)

    user_metadata = params.metadata[params.metadata_cid]
    user_id = params.entity_id
    existing_user = params.existing_records[EntityType.USER][user_id]
    existing_user.is_current = False  # invalidate
    if (
        user_id in params.new_records[EntityType.USER]
        and params.new_records[EntityType.USER][user_id]
    ):  # override with last updated user is in this block
        existing_user = params.new_records[EntityType.USER][user_id][-1]

    user_record = copy_user_record(
        existing_user,
        params.block_number,
        params.event_blockhash,
        params.txhash,
        params.block_datetime,
    )

    user_record = validate_user_metadata(
        params.session,
        user_record,
        user_metadata,
    )

    if not user_record:
        # Validations failed. Do not continue to save.
        return

    user_record = update_user_metadata(
        params.session,
        params.redis,
        user_record,
        user_metadata,
        params.web3,
        params.challenge_bus,
    )
    user_record.metadata_multihash = params.metadata_cid
    user_record = update_legacy_user_images(user_record)
    user_record = validate_user_record(user_record)
    params.add_user_record(user_id, user_record)

    return user_record


def verify_user(params: ManageEntityParameters):
    validate_user_tx(params)

    user_id = params.user_id
    existing_user = params.existing_records[EntityType.USER][user_id]
    user_record = copy_user_record(
        existing_user,
        params.block_number,
        params.event_blockhash,
        params.txhash,
        params.block_datetime,
    )

    user_record = validate_user_record(user_record)
    user_record.is_verified = True
    params.add_user_record(user_id, user_record)

    return user_record
