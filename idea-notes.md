# BetCup - MVP ideas


##  Project Overview
BetCup is a simple web application that allows groups of friends to organize private prediction games for major football tournaments (e.g., FIFA World Cup, UEFA EURO). The system automates collecting predictions, storing match results, and calculating participant scores.

## Main Problem
During large football tournaments, managing a private betting game among friends is typically manual and time-consuming:
- One person must collect predictions from participants
- Predictions must remain hidden to avoid influencing others
- Match results need to be updated regularly
- Scores must be calculated and tracked

This becomes especially problematic during group stages with many matches in a short time.

##  MVP Scope (Minimal Features)

###  User Management
- Users are created by an administrator
- Authentication via login and password
- Single administrator role

###  Tournament Management
- One tournament supported in MVP
- Administrator:
  - creates and manages the tournament
  - manually adds matches (teams, date, time)

###  Match Predictions
- Users can submit predictions for exact match results (e.g., 2:1)
- Predictions are editable until match start time
- Predictions are hidden from other users until the match begins

###  Results & Scoring
- Administrator enters actual match results
- System automatically assigns points based on predefined rules (hardcoded in MVP)
- Leaderboard displays current standings of all participants


##  Out of Scope (MVP)
- Multiple tournaments per user
- Self-registration of users
- Configurable scoring rules
- Integration with external sports APIs
- Notifications (email, push)
- Mobile app


##  Success Criteria
- Users can log in and submit predictions
- Predictions remain hidden until match start
- Administrator can manage matches and input results
- System correctly calculates points and rankings
- Application is usable for a real small tournament scenario


##  Future Improvements (Post-MVP)
- Integration with sports data APIs (e.g., fixtures, results)
- Multiple tournaments support
- Configurable scoring system
- Public/private leagues
- Real-time updates and notifications
