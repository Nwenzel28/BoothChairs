# BoothChairs
A Gale-Shapley algorithm used to simulate Punahou Carnival Booth Chair matching. It can also be used for any kind of stable state matching, but is built around the Punahou Carnival. To use:

**1. Upload Candidates CSV** - Must include CandidateID, Name, Pref1-Pref6

**2. Upload Booths CSV** - Must include RoleID, RoleName, Division (opt), Seats, Rank1-RankN

**3. Click Run Algorithm** and see the results

The results will show the candidates assigned to each booth and statistics like match rate, and number of candidates assigned to first, second, third, and fourth-plus choice. 

Downloading the Results CSV will produce a Final_Matches.csv file with the booth that each candidate was assigned to. The data can be sorted in Google Sheets by CandidateID (default), Name, RoleID, or RoleName.
