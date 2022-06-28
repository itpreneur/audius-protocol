from sqlalchemy import Column, Integer, PrimaryKeyConstraint
from src.models.base import Base


class Stem(Base):
    __tablename__ = "stems"

    parent_track_id = Column(Integer, nullable=False, index=False)
    child_track_id = Column(Integer, nullable=False, index=False)
    PrimaryKeyConstraint(parent_track_id, child_track_id)

    def __repr__(self):
        return f"<Stem(parent_track_id={self.parent_track_id},\
child_track_id={self.child_track_id})>"
